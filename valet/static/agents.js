// Org chart from vidmarholdings AGENTS.md. Specialist-to-CEO grouping is PROPOSED (AGENTS.md lists specialists flat) — confirm with Shadrick.
window.ORG={
 personal:{id:'bagheera_butler.agent',name:'Bagheera',short:'Bags',role:'Personal butler · @Bagsvalet_bot',live:true},
 governance:{id:'aaron_delegate.agent',name:'Aaron',role:'Delegation, routing & governance'},
 ceos:[
  {id:'solomon_ceo.agent',name:'Solomon',role:'Group CEO · Vidmar Holdings',specialists:[
   ['nehemiah_operations.agent','Nehemiah','Operations & scheduling'],['boaz_finance.agent','Boaz','Finance & trading'],
   ['gideon_bull.agent','Gideon','Bullish analysis (under Boaz)'],['samson_bear.agent','Samson','Bearish analysis (under Boaz)'],
   ['ezra_knowledge.agent','Ezra','Knowledge & ideation'],['justus_legal.agent','Justus','Legal (human review)'],
   ['caleb_project.agent','Caleb','Project accountability'],['samuel_hr.agent','Samuel','Human & agent resources'],
   ['zadok_acquisitions.agent','Zadok','Acquisitions'],['vidmar.agent','Vidmar','Personal brand authority']]},
  {id:'barnabas_ceo.agent',name:'Barnabas',role:'CEO · Vidmar Entertainment',specialists:[
   ['bezalel_creative.agent','Bezalel','Creative production'],['hiram_design.agent','Hiram','Design systems'],
   ['matthew_social.agent','Matthew','Social media'],['silas_outreach.agent','Silas','Outreach']]},
  {id:'joseph_ceo.agent',name:'Joseph',role:'CEO · Vidmar AI',specialists:[
   ['nathan_builder.agent','Nathan','Senior builder'],['daniel_digital_commerce.agent','Daniel','Digital commerce'],
   ['issachar_research.agent','Issachar','Research']]},
  {id:'joshua_rez_ceo.agent',name:'Joshua',role:'CEO · Real Estate Zambia',specialists:[
   ['cyrus_government.agent','Cyrus','Government intel (Zambia)'],['eli_ideas.agent','Eli','Ideas & opportunities']]}
 ]};
