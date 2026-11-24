(async()=>{
  const base=document.querySelector('script[src*="staff.js"]').src.replace(/staff\.js.*$/,"/");
  const [a,b]=await Promise.all([
    fetch(base+"staff-app-a.js").then(r=>r.text()),
    fetch(base+"staff-app-b.js").then(r=>r.text())
  ]);
  (0,eval)(a+"\n"+b);
})();
