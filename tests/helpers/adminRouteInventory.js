'use strict';

const fs=require('node:fs');
const path=require('node:path');
const ROOT=path.join(__dirname,'../..');
const FILES=['adminAuth.js','adminAccess.js','adminDashboard.js','adminOrders.js','adminCatalog.js','adminOperations.js','adminSettings.js','phase06.js','phase08Admin.js'];
function collectAdminRouteRegistrations(){
  const routes=[];
  for(const file of FILES){
    const source=fs.readFileSync(path.join(ROOT,'src/routes',file),'utf8');
    for(const match of source.matchAll(/router\.(get|post|put|patch|delete|all)\(\s*(['"])([^'"]+)\2/g)){
      const [,method,,routePath]=match;
      if(routePath.startsWith('/admin')||(file==='adminAuth.js'&&routePath==='/logout'))routes.push({file,method:method.toUpperCase(),path:routePath,source:'literal'});
    }
    if(file==='adminSettings.js'){
      const map=source.match(/const settingsPageMap\s*=\s*\{([\s\S]*?)\n\};/);
      if(map){for(const [,routePath] of map[1].matchAll(/['"](\/admin\/[^'"]+)['"]\s*:/g))routes.push({file,method:'GET',path:routePath,source:'settingsPageMap'});}
    }
  }
  return routes;
}
function collectAdminRoutes(){
  const seen=new Set();
  return collectAdminRouteRegistrations().filter(route=>{const key=`${route.method}\0${route.path}`;if(seen.has(key))return false;seen.add(key);return true;});
}
function concretePath(routePath){
  return routePath.replace(/:id\b/g,'1').replace(/:itemId\b/g,'1').replace(/:status\b/g,'pending').replace(/:type\b/g,'deposit').replace(/:channel\b/g,'facebook').replace(/:lang\b/g,'en');
}
module.exports={collectAdminRoutes,collectAdminRouteRegistrations,concretePath,FILES};
