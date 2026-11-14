/** Admin-only helper for transferring ORIGINAL private Reading Set files into D1.
 * Files are read locally from the administrator's file chooser; answers are
 * submitted only to a same-origin, token-protected API, never to static assets.
 */
export function readingImportPage(section:"reading"|"listening"="reading"): Response {
  const label=section==="listening"?"Listening":"Reading";
  const api=section==="listening"?"/api/cloud/listening-sets/import":"/api/cloud/reading-sets/import";
  const html = [
    '<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    '<title>'+label+' 原始題組匯入</title><style>',
    'body{font-family:system-ui,"Noto Sans TC",sans-serif;max-width:850px;margin:35px auto;padding:0 18px;color:#183352;line-height:1.65}',
    'h1{font-size:1.55rem}input,button{font:inherit;padding:10px}input[type=password]{max-width:520px;width:95%}',
    'button{margin:15px 0;background:#164883;color:#fff;border:0;border-radius:7px;cursor:pointer}button:disabled{opacity:.5}',
    '.card{border:1px solid #d7e0ed;padding:16px;border-radius:10px;margin:16px 0}',
    'pre{white-space:pre-wrap;word-break:break-word;background:#f0f4fa;padding:12px;border-radius:8px}',
    'a{color:#164883}.muted{color:#566780}</style></head><body>',
    '<h1>匯入既有 TOEFL '+label+' Sets（私人管理）</h1>',
    '<p>只匯入原專案既有完整 '+label+' Set JSON，不重新生成。聽力題組必須先部署全部對應 MP3 才允許匯入。</p>',
    '<div class="card"><p><strong>1. 選擇本機原始 Reading 題組檔案（可多選）</strong></p>',
    '<p class="muted">請從 C:\\Users\\isaac\\toefl-prep-tool\\data\\question-sets\\'+section+' 選擇 .json 檔案。答案保留在私人 D1，不能放在 client/public。</p>',
    '<input type="file" id="files" multiple accept=".json,application/json">',
    '<p><strong>2. 輸入 TOEFL_MANUAL_TEST_TOKEN</strong></p>',
    '<input type="password" autocomplete="off" id="token" placeholder="貼上你的測試密碼">',
    '<p><button id="upload">開始匯入已選題組</button></p></div>',
    '<pre id="output" role="status">尚未開始。</pre>',
    '<p><a href="/sets?section='+section+'">返回原版 '+label+' Sets 列表</a></p>',
    '<script>',
    'const byId=id=>document.getElementById(id);const upload=byId("upload"),out=byId("output");',
    'upload.addEventListener("click",async()=>{const files=Array.from(byId("files").files||[]);const token=byId("token").value.trim();',
    'if(!files.length){out.textContent="請先選擇 .json 檔案";return;}if(!token){out.textContent="請先輸入測試密碼";return;}',
    'if(!confirm("確定匯入 "+files.length+" 份原始 Reading Set？既有同名題組不會覆寫。"))return;',
    'upload.disabled=true;out.textContent="開始匯入（每份單獨驗證）…\\n";',
    'let ok=0;for(const file of files){try{if(file.size>450000)throw Error("檔案過大");const raw=await file.text();',
    'const r=await fetch("'+api+'",{method:"POST",credentials:"same-origin",headers:{"Authorization":"Bearer "+token,"Content-Type":"application/json"},body:raw});',
    'const j=await r.json();if(!r.ok)throw Error(j.error||("HTTP "+r.status));ok++;out.textContent+=file.name+": "+j.status+" ("+j.id+")\\n";',
    '}catch(e){out.textContent+=file.name+": 無法匯入 — "+e.message+"\\n";}}',
    'byId("token").value="";out.textContent+="\\n完成："+ok+" / "+files.length+" 份。請返回原版 Reading Sets 頁確認。";upload.disabled=false;});',
    '</script></body></html>'
  ].join("\n");
  return new Response(html, { headers:{
    "Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store","X-Content-Type-Options":"nosniff",
    "Content-Security-Policy":"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
  }});
}
