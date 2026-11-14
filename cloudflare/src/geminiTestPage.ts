/** Private manual test page. Protected by Cloudflare Access and a separate test token. */
export function geminiTestPage(): Response {
 const html = [
 '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
 '<title>TOEFL Gemini 一次性測試</title>',
 '<style>body{font-family:system-ui,sans-serif;max-width:700px;margin:35px auto;padding:0 18px;line-height:1.6;color:#152238}input,button{font:inherit;padding:10px}input{width:90%;max-width:500px}button{background:#1848a0;color:white;border:0;border-radius:6px;cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f0f3f7;padding:14px}</style>',
 '</head><body><h1>Gemini Reading 一次性出題測試</h1>',
 '<p>本測試只產生一篇學術閱讀草稿與五題選擇題，存入 D1 待審區；不會發布成正式 TOEFL 題組。每天最多嘗試一次。</p>',
 '<label>一次性測試密碼（不是 Gemini API Key）</label><p><input id="token" type="password" autocomplete="off" placeholder="貼上測試密碼"></p>',
 '<button id="run">產生一份待審草稿</button>',
 '<p>可能使用 Gemini API 額度。請確認已透過 Cloudflare Access 登入。</p><pre id="result" aria-live="polite">尚未執行</pre>',
 '<script>',
 'const btn=document.getElementById("run"),out=document.getElementById("result"),input=document.getElementById("token");',
 'btn.addEventListener("click",async()=>{',
 'const token=input.value.trim(); if(!token){out.textContent="請輸入測試密碼";return;}',
 'if(!confirm("確定執行一次 Gemini 內容生成？這可能消耗 API 額度。"))return;',
 'btn.disabled=true;out.textContent="正在請求 Gemini…";',
 'try{ const res=await fetch("/api/cloud/gemini-generate-once",{method:"POST",credentials:"same-origin",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:JSON.stringify({confirm:"GENERATE_ONCE"})});',
 'const data=await res.json();out.textContent=JSON.stringify({httpStatus:res.status,...data},null,2);',
 '}catch{out.textContent="請求失敗，請確認網路與登入狀態";}',
 'finally{btn.disabled=false;input.value="";}',
 '});</script></body></html>'
 ].join("\n");
 return new Response(html,{headers:{
   "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store",
   "X-Content-Type-Options":"nosniff",
   "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
 }});
}
