// ================= 功率监测 WebUI =================
// 列: 0=ts 1=soc 2=cpum 3=cpul 4=gpu 5=nsp 6=batt 7=chg 8=cput 9=gput 10=battT 11=cap 12=st

// ---------- KernelSU bridge ----------
function bridge(){ return globalThis.ksu || window.ksu || null; }
function extractStdout(raw){
  if (raw == null) return "";
  if (typeof raw === "string"){
    try { const o = JSON.parse(raw);
      if (typeof o?.stdout === "string") return o.stdout;
      if (typeof o?.out === "string") return o.out;
    } catch(e){}
    return raw;
  }
  if (typeof raw?.stdout === "string") return raw.stdout;
  if (typeof raw?.out === "string") return raw.out;
  return String(raw);
}
function sh(cmd){
  const b = bridge();
  if (!b || !b.exec) return "";
  return extractStdout(b.exec(cmd));
}
function toast(msg){ try{ bridge()?.toast?.(msg); }catch(e){} }
function shq(s){ return "'" + String(s).replace(/'/g, "'\\''") + "'"; }

let MODDIR = "";
function findModdir(){
  return sh('for d in /data/adb/modules/*/; do [ -f "${d}bin/power_daemon.sh" ] && printf "%s" "${d%/}" && break; done').trim();
}
function ctl(arg){ return sh('MODDIR=' + shq(MODDIR) + ' sh ' + shq(MODDIR + '/bin/ctl.sh') + ' ' + arg); }

// ---------- 列索引 ----------
const C = { TS:0, SOC:1, CPUM:2, CPUL:3, GPU:4, NSP:5, BATT:6, CHG:7, CPUT:8, GPUT:9, BATT_T:10, CAP:11, ST:12 };

const SERIES = [
  {key:"batt",  idx:C.BATT, label:"整机功耗", color:"#ff6b6b", type:"power", on:true},
  {key:"soc",   idx:C.SOC,  label:"SoC 总",   color:"#ff922b", type:"power", on:true},
  {key:"cpum",  idx:C.CPUM, label:"CPU大核",  color:"#4dabf7", type:"power", on:true},
  {key:"cpul",  idx:C.CPUL, label:"CPU小核",  color:"#69db7c", type:"power", on:true},
  {key:"gpu",   idx:C.GPU,  label:"GPU",      color:"#ffd43b", type:"power", on:true},
  {key:"nsp",   idx:C.NSP,  label:"NSP",      color:"#b197fc", type:"power", on:false},
  {key:"chg",   idx:C.CHG,  label:"充电功率", color:"#38d9a9", type:"power", on:true},
  {key:"cput",  idx:C.CPUT, label:"CPU温度",  color:"#ff8787", type:"temp",  on:true},
  {key:"gput",  idx:C.GPUT, label:"GPU温度",  color:"#f783ac", type:"temp",  on:true},
  {key:"battT", idx:C.BATT_T,label:"电池温度",color:"#ffa94d", type:"temp",  on:true},
];
const active = {}; SERIES.forEach(s => active[s.key] = s.on);

let raw = [];
let winSec = 60, running = false, chart = null;
let showPowerAxis = true, showTempAxis = true;
let dischPage = 1, chgPage = 1;
const PER_PAGE = 10;

// ---------- 格式化 ----------
function fmtW(uw){ const w=uw/1e6; return Math.abs(w)>=1 ? w.toFixed(2)+" W" : (uw/1e3).toFixed(0)+" mW"; }
function fmtT(t){ return (t/1000).toFixed(1)+"℃"; }
function pad2(n){ return n<10?"0"+n:""+n; }
function hhmmss(ms){ const d=new Date(ms); return pad2(d.getHours())+":"+pad2(d.getMinutes())+":"+pad2(d.getSeconds()); }
function hhmm(ms){ const d=new Date(ms); return pad2(d.getMonth()+1)+"/"+pad2(d.getDate())+" "+pad2(d.getHours())+":"+pad2(d.getMinutes()); }
function fmtDur(ms){
  const s = Math.floor(ms/1000);
  if (s < 60) return s + " 秒";
  const m = Math.floor(s/60), ss = s%60;
  if (m < 60) return m + "分" + ss + "秒";
  const hh = Math.floor(m/60), mm = m%60;
  return hh + "时" + mm + "分";
}

// ---------- 会话划分：按 st 连续段切分 ----------
function buildSessions(){
  const sessions = [];
  let cur = null;
  for (const p of raw){
    const st = p[C.ST];
    const kind = st === 0 ? "disch" : (st === 1 ? "chg" : null);
    if (kind === null){                       // 充满/未知打断会话
      if (cur){ sessions.push(cur); cur = null; }
      continue;
    }
    if (!cur || cur.kind !== kind){
      if (cur) sessions.push(cur);
      cur = { kind, startTs:p[C.TS], endTs:p[C.TS], n:0,
              sumBatt:0, maxBatt:0, sumChg:0, maxChg:0,
              startCap:p[C.CAP], endCap:p[C.CAP] };
    }
    cur.endTs = p[C.TS];
    cur.n++;
    const ab = Math.abs(p[C.BATT]);
    cur.sumBatt += ab;
    if (ab > cur.maxBatt) cur.maxBatt = ab;
    cur.sumChg += p[C.CHG];
    if (p[C.CHG] > cur.maxChg) cur.maxChg = p[C.CHG];
    cur.endCap = p[C.CAP];
  }
  if (cur) sessions.push(cur);
  for (const s of sessions){
    s.avgBatt = s.n ? s.sumBatt/s.n : 0;
    s.avgChg  = s.n ? s.sumChg/s.n : 0;
    s.durMs   = s.endTs - s.startTs;
  }
  return sessions;
}

// ---------- canvas ----------
function fitCanvas(){
  const cv = document.getElementById("chart");
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 320, h = 260;
  cv.width = w*dpr; cv.height = h*dpr;
  cv.style.height = h + "px";
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr,0,0,dpr,0,0);
  chart = { ctx, w, h };
}
function loadData(){
  const out = ctl("read 900");
  const pts = [];
  for (const line of out.split(/\r?\n/)){
    const s = line.trim(); if (!s) continue;
    const a = s.split(/\s+/);
    if (a.length < 13) continue;
    const nums = a.map(Number);
    if (nums.some(isNaN)) continue;
    pts.push(nums);
  }
  raw = pts;
}
function niceStep(maxV){
  const r = maxV/4;
  const p = Math.pow(10, Math.floor(Math.log10(r)||0));
  const n = r/p;
  let m; if (n<=1)m=1; else if(n<=2)m=2; else if(n<=2.5)m=2.5; else if(n<=5)m=5; else m=10;
  return m*p;
}
function draw(){
  if (!chart) fitCanvas();
  const {ctx,w,h} = chart;
  ctx.clearRect(0,0,w,h);
  const hasLeft = showPowerAxis, hasRight = showTempAxis;
  const padL = hasLeft?50:8, padR = hasRight?46:10, padT = 14, padB = 28;
  const plotW = Math.max(10, w-padL-padR), plotH = h-padT-padB;

  const now = raw.length ? raw[raw.length-1][C.TS] : Date.now();
  const t0 = now - winSec*1000;
  const pts = raw.filter(p => p[C.TS] >= t0);

  let maxPow = 0, minPow = 0, maxTemp = 0, minTemp = 200;
  for (const p of pts){
    for (const s of SERIES){
      if (!active[s.key]) continue;
      const v = p[s.idx];
      if (s.type === "power"){ if (v>maxPow) maxPow=v; if (v<minPow) minPow=v; }
      else { if (v>maxTemp) maxTemp=v; if (v<minTemp) minTemp=v; }
    }
  }
  if (maxPow <= 0) maxPow = 1e6;
  maxPow *= 1.15;
  // 支持负值(充电时整机功率为负): 若有负值, Y 轴向下扩展
  let yPowMin = 0;
  if (minPow < 0){
    minPow *= 1.15;
    const pStep = niceStep(-minPow);
    yPowMin = -Math.ceil(-minPow/pStep)*pStep;
  }
  const powStep = niceStep(maxPow);
  const yPowMax = Math.ceil(maxPow/powStep)*powStep;
  const powRange = Math.max(1, yPowMax - yPowMin);

  let yTempMin = Math.floor((minTemp===200?0:minTemp/1000-5)/10)*10;
  let yTempMax = Math.ceil((maxTemp/1000+3)/10)*10;
  if (yTempMax-yTempMin < 20) yTempMax = yTempMin+20;
  if (yTempMin < 0) yTempMin = 0;

  ctx.font = "10px sans-serif"; ctx.lineWidth = 1;
  // 功率网格: 从 yPowMin 到 yPowMax(支持负值), 每 powStep 一条
  for (let v = yPowMin; v <= yPowMax + 1; v += powStep){
    const y = padT+plotH-((v - yPowMin)/powRange)*plotH;
    if (y < padT-1 || y > padT+plotH+1) continue;
    const isZero = (v === 0);
    ctx.strokeStyle = isZero ? "#3a4656" : "#1e2530";   // 0 线略亮
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(padL+plotW,y); ctx.stroke();
    if (hasLeft){ ctx.fillStyle = v<0 ? "#c88" : "#ff9f9f"; ctx.textAlign="right"; ctx.textBaseline="middle"; ctx.fillText(fmtW(v), padL-5, y); }
  }
  if (hasRight){
    const ts = Math.round((yTempMax-yTempMin)/10);
    for (let i=0;i<=ts;i++){
      const tv = yTempMin+i*10;
      const y = padT+plotH-((tv-yTempMin)/(yTempMax-yTempMin))*plotH;
      ctx.fillStyle="#9fd0ff"; ctx.textAlign="left"; ctx.textBaseline="middle"; ctx.fillText(tv+"℃", padL+plotW+5, y);
    }
  }
  const xTicks = 4;
  for (let i=0;i<=xTicks;i++){
    const frac=i/xTicks, x=padL+frac*plotW;
    const d=new Date(t0+frac*winSec*1000);
    ctx.fillStyle="#6b7684"; ctx.textAlign="center"; ctx.textBaseline="top";
    ctx.fillText(pad2(d.getHours())+":"+pad2(d.getMinutes())+":"+pad2(d.getSeconds()), x, padT+plotH+7);
    ctx.strokeStyle="#161c26";
    ctx.beginPath(); ctx.moveTo(x,padT); ctx.lineTo(x,padT+plotH); ctx.stroke();
  }
  if (pts.length >= 2){
    for (const s of SERIES){
      if (!active[s.key]) continue;
      const isPow = s.type==="power";
      if (isPow && !hasLeft) continue;
      if (!isPow && !hasRight) continue;
      ctx.strokeStyle=s.color; ctx.lineWidth=1.5; ctx.beginPath();
      let started=false;
      for (const p of pts){
        const x=padL+((p[C.TS]-t0)/(winSec*1000))*plotW;
        let y;
        if (isPow) y=padT+plotH-((p[s.idx]-yPowMin)/powRange)*plotH;
        else y=padT+plotH-((p[s.idx]/1000-yTempMin)/(yTempMax-yTempMin))*plotH;
        if (!started){ ctx.moveTo(x,y); started=true; } else ctx.lineTo(x,y);
      }
      ctx.stroke();
    }
  } else {
    ctx.fillStyle="#4b5563"; ctx.textAlign="center"; ctx.textBaseline="middle"; ctx.font="13px sans-serif";
    ctx.fillText(running?"正在采集数据…":"暂无数据，点「开始采样」", w/2, h/2);
  }
  ctx.strokeStyle="#30363d"; ctx.strokeRect(padL,padT,plotW,plotH);
}

function renderLegend(){
  const box = document.getElementById("legend");
  const last = raw.length ? raw[raw.length-1] : null;
  box.innerHTML = SERIES.map(s => {
    const v = last ? last[s.idx] : 0;
    const txt = s.type==="power" ? fmtW(v) : fmtT(v);
    return '<div class="lg '+(active[s.key]?'active':'')+'" data-k="'+s.key+'">'
      + '<span class="dot" style="background:'+s.color+'"></span>'
      + '<span>'+s.label+'</span><span class="val">'+txt+'</span></div>';
  }).join("");
  box.querySelectorAll(".lg").forEach(el=>{
    el.onclick=()=>{ const k=el.dataset.k; active[k]=!active[k]; renderLegend(); draw(); };
  });
}

// ---------- 读取归档会话 ----------
// 归档格式: kind startTs endTs n avgBatt maxBatt avgChg maxChg startCap endCap
let archive = [];
function loadArchive(){
  const out = ctl("archive");
  const list = [];
  for (const line of out.split(/\r?\n/)){
    const s = line.trim(); if (!s) continue;
    const a = s.split(/\s+/);
    if (a.length < 10) continue;
    const nums = a.slice(1).map(Number);
    if (nums.some(isNaN)) continue;
    list.push({
      kind: a[0],
      startTs: nums[0], endTs: nums[1], n: nums[2],
      avgBatt: nums[3], maxBatt: nums[4],
      avgChg: nums[5], maxChg: nums[6],
      startCap: nums[7], endCap: nums[8],
      durMs: nums[1] - nums[0],
      archived: true
    });
  }
  archive = list;   // 归档文件本身是最新在后
}

// 合并: 归档会话 + 内存中尚未归档的会话
// 返回按时间倒序(最新在前)的列表
function allSessions(kind){
  const inMem = buildSessions().filter(s => s.kind === kind);
  // 内存中最后一个会话若与归档最后一条时间重叠, 说明已被归档, 去掉避免重复
  let mem = inMem;
  const arch = archive.filter(s => s.kind === kind);
  if (arch.length && mem.length){
    const lastArch = arch[arch.length-1];   // 归档里最新的(按写入顺序)
    mem = mem.filter(s => s.startTs !== lastArch.startTs || s.n !== lastArch.n);
  }
  const merged = arch.concat(mem);
  merged.sort((a,b) => b.startTs - a.startTs);   // 倒序: 最新在前
  return merged;
}

// ---------- 统计渲染 ----------
function renderStats(){
  loadArchive();
  const last = raw.length ? raw[raw.length-1] : null;
  const nowSt = last ? last[C.ST] : 3;
  const nowTs = last ? last[C.TS] : Date.now();

  const dischList = allSessions("disch");
  const chgList   = allSessions("chg");

  // ---- 当前放电实时 ----
  const curD = (nowSt === 0 && dischList.length) ? dischList[0] : null;
  const dTag = document.getElementById("dischTag");
  if (curD){
    dTag.textContent = "进行中";
    dTag.className = "tag live";
    document.getElementById("d-start").textContent = hhmmss(curD.startTs);
    document.getElementById("d-dur").textContent   = fmtDur(nowTs - curD.startTs);
    document.getElementById("d-avg").textContent   = fmtW(curD.avgBatt);
    document.getElementById("d-max").textContent   = fmtW(curD.maxBatt);
  } else {
    dTag.textContent = "未放电";
    dTag.className = "tag";
    document.getElementById("d-start").textContent = "--";
    document.getElementById("d-dur").textContent   = "--";
    document.getElementById("d-avg").textContent   = "--";
    document.getElementById("d-max").textContent   = "--";
  }

  // ---- 当前充电实时 ----
  const curC = (nowSt === 1 && chgList.length) ? chgList[0] : null;
  const cTag = document.getElementById("chgTag");
  if (curC){
    cTag.textContent = "进行中";
    cTag.className = "tag live";
    document.getElementById("c-start").textContent = hhmmss(curC.startTs);
    document.getElementById("c-dur").textContent   = fmtDur(nowTs - curC.startTs);
    document.getElementById("c-avg").textContent   = fmtW(curC.avgChg);
    document.getElementById("c-cap").textContent   = curC.startCap + "% → " + curC.endCap + "%";
  } else {
    cTag.textContent = "未充电";
    cTag.className = "tag";
    document.getElementById("c-start").textContent = "--";
    document.getElementById("c-dur").textContent   = "--";
    document.getElementById("c-avg").textContent   = "--";
    document.getElementById("c-cap").textContent   = "--";
  }

  renderSessionList("disch", dischList, curD);
  renderSessionList("chg", chgList, curC);
}

function renderSessionList(kind, list, curSession){
  const listEl  = document.getElementById(kind === "disch" ? "dischList" : "chgList");
  const pagerEl = document.getElementById(kind === "disch" ? "dischPager" : "chgPager");
  const pageEl  = document.getElementById(kind === "disch" ? "dPage" : "cPage");

  if (!list.length){
    listEl.innerHTML = '<div class="empty">暂无历史记录</div>';
    pagerEl.style.display = "none";
    return;
  }
  const totalPages = Math.max(1, Math.ceil(list.length / PER_PAGE));
  let page = kind === "disch" ? dischPage : chgPage;
  if (page > totalPages) page = totalPages;
  if (page < 1) page = 1;
  if (kind === "disch") dischPage = page; else chgPage = page;

  const slice = list.slice((page-1)*PER_PAGE, page*PER_PAGE);
  listEl.innerHTML = slice.map((s, i) => {
    const globalIdx = list.length - ((page-1)*PER_PAGE + i);
    const isLive = (s === curSession);
    const powTxt = kind === "disch"
      ? ("平均 " + fmtW(s.avgBatt) + " · 峰值 " + fmtW(s.maxBatt))
      : ("平均 " + fmtW(s.avgChg) + " · 峰值 " + fmtW(s.maxChg) + " · 电量 " + s.startCap + "%→" + s.endCap + "%");
    return '<div class="sess ' + kind + '">'
      + '<span class="idx">#' + globalIdx + (isLive ? ' ●' : '') + '</span>'
      + '<span class="when">' + hhmm(s.startTs) + ' → ' + hhmm(s.endTs) + '</span>'
      + '<span class="dur">' + fmtDur(s.durMs) + '</span>'
      + '<span class="detail">' + powTxt + ' · ' + s.n + ' 个采样点</span>'
      + '</div>';
  }).join("");

  pagerEl.style.display = totalPages > 1 ? "flex" : "none";
  pageEl.textContent = page + "/" + totalPages;
}

// ---------- 状态 ----------
function refreshStatus(){
  const s = ctl("status");
  const kv = {};
  for (const line of s.split(/\r?\n/)){ const i=line.indexOf("="); if(i>0) kv[line.slice(0,i)]=line.slice(i+1); }
  const supported = kv.SUPPORTED === "1";
  running = kv.RUNNING === "1";
  const chip = document.getElementById("runChip");
  if (!supported){ chip.textContent="设备不支持"; chip.className="chip off"; }
  else if (running){ chip.textContent="采集中"; chip.className="chip on"; }
  else { chip.textContent="已停止"; chip.className="chip off"; }
  document.getElementById("startBtn").disabled = running || !supported;
  document.getElementById("stopBtn").disabled = !running;
}

function tick(){
  refreshStatus();
  loadData();
  const last = raw.length ? raw[raw.length-1] : null;
  if (last){
    document.getElementById("vBatt").textContent = fmtW(Math.abs(last[C.BATT]));
    document.getElementById("vCpuT").textContent = fmtT(last[C.CPUT]);
    document.getElementById("vGpuT").textContent = fmtT(last[C.GPUT]);
    document.getElementById("vSoc").textContent  = fmtW(last[C.SOC]);
    document.getElementById("vChg").textContent  = fmtW(last[C.CHG]);
    document.getElementById("vBat").textContent  = last[C.CAP] + "% / " + fmtT(last[C.BATT_T]);
  }
  renderLegend();
  renderStats();
  draw();
}

// ---------- 窗口 ----------
function setWin(sec, id){
  winSec = sec;
  ["win60","win300","win900"].forEach(x=>document.getElementById(x).classList.toggle("on", x===id));
  draw();
}

// ---------- UI ----------
function bindUI(){
  document.getElementById("startBtn").onclick = () => {
    const r = ctl("start");
    toast(r.includes("STARTED=1")?"已开始采样":"启动失败");
    setTimeout(tick, 800);
  };
  document.getElementById("stopBtn").onclick = () => { ctl("stop"); toast("已停止采样"); setTimeout(tick,500); };
  document.getElementById("clearBtn").onclick = () => {
    ctl("stop"); sh(": > /data/local/tmp/power_monitor.dat"); ctl("start");
    dischPage = 1; chgPage = 1;
    toast("实时数据已清空"); setTimeout(tick, 800);
  };
  document.getElementById("clearArchBtn").onclick = () => {
    ctl("archive-clear");
    dischPage = 1; chgPage = 1;
    loadArchive();
    toast("归档记录已清空"); setTimeout(tick, 500);
  };
  document.getElementById("win60").onclick  = () => setWin(60,"win60");
  document.getElementById("win300").onclick = () => setWin(300,"win300");
  document.getElementById("win900").onclick = () => setWin(900,"win900");
  document.getElementById("axisPower").onchange = e => { showPowerAxis = e.target.checked; draw(); };
  document.getElementById("axisTemp").onchange  = e => { showTempAxis  = e.target.checked; draw(); };

  // 翻页
  document.getElementById("dPrev").onclick = () => { dischPage--; renderStats(); };
  document.getElementById("dNext").onclick = () => { dischPage++; renderStats(); };
  document.getElementById("cPrev").onclick = () => { chgPage--;  renderStats(); };
  document.getElementById("cNext").onclick = () => { chgPage++;  renderStats(); };

  window.addEventListener("resize", () => { fitCanvas(); draw(); });
}

// ---------- init ----------
function init(){
  MODDIR = findModdir();
  if (!MODDIR){
    document.getElementById("hintMsg").innerHTML = '<span class="err">模块目录未找到，WebUI 无法工作。</span>';
    return;
  }
  document.getElementById("devSub").textContent = "模块: " + MODDIR.split("/").pop();
  fitCanvas();
  bindUI();
  tick();
  setInterval(tick, 2000);
}
init();