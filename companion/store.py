"""Private SQLite state. Only digests of pairing codes and bearer tokens persist."""
from contextlib import contextmanager
import hashlib
import os
import secrets
import sqlite3
import time
from pathlib import Path


def digest(value):
    return hashlib.sha256(value.encode()).hexdigest()


class Store:
    def __init__(self, root):
        self.root = Path(root)
        self.root.mkdir(parents=True, exist_ok=True, mode=0o700)
        self.root.chmod(0o700)
        self.db = self.root / 'state.sqlite3'
        fd = os.open(self.db, os.O_CREAT | os.O_WRONLY, 0o600)
        os.close(fd)
        self.db.chmod(0o600)
        with self.connect() as db:
            db.executescript("""
                CREATE TABLE IF NOT EXISTS pairing (hash TEXT PRIMARY KEY, expires REAL);
                CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, hash TEXT UNIQUE, expires REAL, owner TEXT, agent TEXT DEFAULT 'bags');
                CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, session TEXT, mime TEXT, size INTEGER);
                CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, session TEXT, action TEXT, status TEXT, result TEXT, created REAL);
                CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, session TEXT, payload TEXT);
                CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, owner TEXT, payload TEXT, created REAL);
            """)

    @contextmanager
    def connect(self):
        db = sqlite3.connect(self.db, timeout=5)
        try:
            with db:
                yield db
        finally:
            db.close()

    def cleanup_expired(self):
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            expired = [row[0] for row in db.execute('SELECT id FROM sessions WHERE expires<=?', (time.time(),))]
            for sid in expired:
                for (file_id,) in db.execute('SELECT id FROM uploads WHERE session=?', (sid,)).fetchall():
                    (self.root / 'uploads' / file_id).unlink(missing_ok=True)
                for table in ('uploads', 'tasks', 'events'):
                    db.execute(f'DELETE FROM {table} WHERE session=?', (sid,))
                db.execute('DELETE FROM sessions WHERE id=?', (sid,))
            # Reconcile interrupted writes/legacy orphan metadata, under the same write lock.
            for (file_id,) in db.execute('SELECT id FROM uploads WHERE session NOT IN (SELECT id FROM sessions)').fetchall():
                (self.root / 'uploads' / file_id).unlink(missing_ok=True)
            for table in ('uploads', 'tasks', 'events'):
                db.execute(f'DELETE FROM {table} WHERE session NOT IN (SELECT id FROM sessions)')
            db.execute('DELETE FROM meetings WHERE owner NOT IN (SELECT owner FROM sessions)')
            known = {row[0] for row in db.execute('SELECT id FROM uploads')}
            folder = self.root / 'uploads'
            if folder.exists():
                for item in folder.iterdir():
                    if item.is_file() and item.name not in known:
                        item.unlink()
            db.execute('DELETE FROM pairing WHERE expires<=?', (time.time(),))

    def issue_pairing(self, ttl=300):
        code = secrets.token_urlsafe(24)
        with self.connect() as db:
            db.execute('DELETE FROM pairing')
            db.execute('INSERT INTO pairing VALUES (?,?)', (digest(code), time.time()+ttl))
        return code

    def pair(self, code):
        if not isinstance(code, str) or len(code) > 200:
            return None
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            row = db.execute('SELECT expires FROM pairing WHERE hash=?', (digest(code),)).fetchone()
            if not row or row[0] <= time.time():
                return None
            if db.execute('SELECT count(*) FROM sessions').fetchone()[0] >= 1000:
                return None
            db.execute('DELETE FROM pairing WHERE hash=?', (digest(code),))
            sid, token, expires = secrets.token_hex(16), secrets.token_urlsafe(32), time.time()+3600
            db.execute('INSERT INTO sessions VALUES (?,?,?,?,?)', (sid, digest(token), expires, sid, 'bags'))
        return dict(session_id=sid, token=token, expires_at=expires)

    def identity(self, sid):
        with self.connect() as db:
            row = db.execute('SELECT owner,agent,expires FROM sessions WHERE id=?', (sid,)).fetchone()
        return {'owner': row[0], 'agent_id': row[1], 'expires_at': row[2]} if row else None

    def agent_session(self, sid, agent):
        token = secrets.token_urlsafe(32)
        with self.connect() as db:
            db.execute('BEGIN IMMEDIATE')
            source = db.execute('SELECT owner,expires FROM sessions WHERE id=? AND expires>?', (sid, time.time())).fetchone()
            if not source:
                return None
            identity = {'owner': source[0], 'expires_at': source[1]}
            row = db.execute('SELECT id FROM sessions WHERE owner=? AND agent=?', (identity['owner'], agent)).fetchone()
            if row:
                new_sid = row[0]
                db.execute('UPDATE sessions SET hash=? WHERE id=?', (digest(token), new_sid))
            else:
                if db.execute('SELECT count(*) FROM sessions').fetchone()[0] >= 1000:
                    return None
                new_sid = secrets.token_hex(16)
                db.execute('INSERT INTO sessions VALUES (?,?,?,?,?)',
                           (new_sid, digest(token), identity['expires_at'], identity['owner'], agent))
        return dict(session_id=new_sid, token=token, expires_at=identity['expires_at'], agent_id=agent)

    def authenticate(self, token):
        if not isinstance(token, str) or len(token) > 200:
            return None
        with self.connect() as db:
            row = db.execute('SELECT id FROM sessions WHERE hash=? AND expires>?',
                             (digest(token), time.time())).fetchone()
        return row[0] if row else None
