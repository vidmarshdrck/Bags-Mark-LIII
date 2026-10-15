"""Private read-only roster snapshot; selection never impersonates an unconnected agent."""
import json
from pathlib import Path
from .providers import UnavailableProvider


class AgentRoutes:
    def __init__(self, root, bags_provider):
        self.bags_provider = bags_provider
        self.agents = {'bags': {'id': 'bags', 'name': 'Bags', 'role': 'Personal butler',
                               'route': 'separate_companion_session', 'runtime_state': 'companion_only'}}
        path = Path(root) / 'agents.json'
        if path.exists():
            rows = json.loads(path.read_text())
            if not isinstance(rows, list) or len(rows) > 100:
                raise ValueError('invalid_private_agent_registry')
            for row in rows:
                agent_id, name = row.get('id'), row.get('name')
                if not isinstance(agent_id, str) or not isinstance(name, str) or len(agent_id) > 80 or len(name) > 100:
                    raise ValueError('invalid_private_agent_registry')
                if agent_id == 'bags':
                    continue
                self.agents[agent_id] = {'id': agent_id, 'name': name, 'role': str(row.get('role', ''))[:100],
                                         'route': 'disconnected', 'runtime_state': str(row.get('runtime_state', 'unverified'))[:40]}

    def provider_for(self, store, sid):
        identity = store.identity(sid)
        if identity and identity['agent_id'] == 'bags':
            return self.bags_provider
        return UnavailableProvider('Selected real agent is listed but its runtime is not connected. No substitute identity is generated.')
