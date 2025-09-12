// Realtime client (Socket.IO) + minimal local auth placeholder
const views = ["slide1", "slide2", "monitoring", "slide3", "slide4"];
const $ = (q) => document.querySelector(q);
const $$ = (q) => document.querySelectorAll(q);
function goto(id){ views.forEach(v=>$("#"+v).classList.remove("active")); $("#"+id).classList.add("active"); }

function toast(msg){ let t=$(".toast"); if(!t){ t=document.createElement("div"); t.className="toast"; document.body.appendChild(t);} t.textContent=msg; t.classList.add("show"); setTimeout(()=>t.classList.remove("show"),1600); }

let socket = null;
let currentUser = null;
let currentRoom = null;

// --- Slide 1 ---
$("#btnMonitoring").addEventListener("click", ()=> goto("slide2"));

$("#btnJoin").addEventListener("click", async ()=>{
  const id = prompt("새 아이디");
  if(!id) return;
  const pw = prompt("비밀번호");
  if(!pw) return;
  const res = await fetch("/api/join", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id, pw})});
  const j = await res.json();
  if(!res.ok){ return toast(j.message || "가입 실패"); }
  toast("가입 완료");
});

$("#btnLogin").addEventListener("click", async ()=>{
  const id = $("#loginId").value.trim();
  const pw = $("#loginPw").value;
  if(!id || !pw) return toast("ID/PW 입력");
  if(id==="admin" && pw==="admin"){ return toast("관리자 로그인은 Monitoring에서"); }
  const res = await fetch("/api/login", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({id, pw})});
  const j = await res.json();
  if(!res.ok){ return toast(j.message || "로그인 실패"); }
  currentUser = { id };
  $("#currentUser").textContent = currentUser.id;
  connectSocket();
  goto("slide3");
  renderRooms();
});

// --- Slide 2 (Admin) ---
$("#btnAdminLogin").addEventListener("click", async ()=>{
  const id = $("#adminId").value.trim();
  const pw = $("#adminPw").value;
  if(id==="admin" && pw==="admin"){
    connectSocket();
    goto("monitoring");
    requestMonitoring();
  } else {
    toast("어드민 계정이 아닙니다.");
  }
});
$("[data-goto='slide1']")?.addEventListener("click",()=>goto("slide1"));
$("#btnAdminLogout").addEventListener("click",()=>{ goto("slide2"); });

// --- User Home (Slide 3) ---
$("#btnLogout").addEventListener("click",()=>{
  if(socket){ socket.disconnect(); socket=null; }
  currentUser=null; currentRoom=null;
  $("#loginId").value=""; $("#loginPw").value="";
  goto("slide1");
});

$("#btnGoMonitoring").addEventListener("click",()=> goto("slide2"));

$("#btnCreateRoom").addEventListener("click", async ()=>{
  const name = $("#roomName").value.trim();
  const pw = $("#roomPw").value;
  if(!name) return toast("방 이름 입력");
  const res = await fetch("/api/rooms", {method:"POST", headers:{"Content-Type":"application/json"}, body: JSON.stringify({name, pw})});
  const j = await res.json();
  if(!res.ok) return toast(j.message || "생성 실패");
  $("#roomName").value=""; $("#roomPw").value="";
  renderRooms();
});

async function renderRooms(){
  const list = $("#roomList");
  const res = await fetch("/api/rooms");
  const rooms = await res.json();
  list.innerHTML="";
  if(!rooms.length){
    list.classList.add("empty");
    list.innerHTML = `<li class="muted">아직 만들어진 방이 없습니다.</li>`;
    return;
  }
  list.classList.remove("empty");
  rooms.forEach(room=>{
    const li = document.createElement("li");
    li.innerHTML = `<span>${room.name}</span>
      <div style="display:flex; gap:6px;">
        <button class="ghost" data-act="enter" data-name="${room.name}">입장</button>
      </div>`;
    list.appendChild(li);
  });
  list.querySelectorAll("button[data-act='enter']").forEach(btn=>{
    btn.addEventListener("click", async ()=>{
      const name = btn.dataset.name;
      const detail = await (await fetch(`/api/rooms/${encodeURIComponent(name)}`)).json();
      if(detail.pw){
        const input = prompt("방 비밀번호");
        if(input !== detail.pw) return toast("비밀번호 오류");
      }
      currentRoom = name;
      socket.emit("room:join", { room: name, user: currentUser.id });
    });
  });
}

// --- Chat (Slide 4) ---
$("#btnSend").addEventListener("click", sendMessage);
$("#chatInput").addEventListener("keydown", e=>{ if(e.key==="Enter") sendMessage(); });
$("#btnLeaveRoom").addEventListener("click", ()=>{
  if(currentRoom){ socket.emit("room:leave", { room: currentRoom }); }
  currentRoom=null; goto("slide3"); renderRooms();
});

function drawMessage(msg){
  const li = document.createElement("li");
  li.className = "msg" + (msg.user === currentUser?.id ? " me" : "");
  li.innerHTML = `
    <div class="meta"><strong>${msg.user}</strong><span>${new Date(msg.time).toLocaleTimeString()}</span></div>
    ${msg.text ? `<div class="bubble">${escapeHtml(msg.text)}</div>` : ""}
    ${msg.file ? `<div class="file">📎 <a href="${msg.file.url}" download="${msg.file.name}">${msg.file.name}</a> (${formatBytes(msg.file.size||0)})</div>` : ""}`;
  $("#chatList").appendChild(li);
  $("#chatList").scrollTop = $("#chatList").scrollHeight;
}

async function sendMessage(){
  const text = $("#chatInput").value.trim();
  const fileEl = $("#fileInput");
  if(!currentRoom || (!text && !fileEl.files.length)) return;
  let fileInfo = null;
  if(fileEl.files.length){
    const f = fileEl.files[0];
    const fd = new FormData();
    fd.append("file", f);
    const res = await fetch(`/api/upload`, { method: "POST", body: fd });
    const j = await res.json();
    fileInfo = { name: j.name, url: j.url, size: f.size };
    fileEl.value="";
  }
  socket.emit("chat:message", { room: currentRoom, text, file: fileInfo });
  $("#chatInput").value = "";
}

// --- Socket helpers ---
function connectSocket(){
  if(socket && socket.connected) return;
  socket = io({ path: "/socket.io" });
  socket.on("connect", ()=>{
    // attach identity
    socket.emit("auth", { user: currentUser?.id || "admin" });
  });
  socket.on("room:joined", payload=>{
    $("#chatRoomName").textContent = payload.room;
    $("#memberCount").textContent = `현재 인원: ${payload.members}`;
    $("#chatList").innerHTML = "";
    payload.history.forEach(drawMessage);
    goto("slide4");
  });
  socket.on("room:left", payload=>{
    if(payload.room === currentRoom){
      $("#memberCount").textContent = `현재 인원: ${payload.members}`;
    }
  });
  socket.on("presence:update", payload=>{
    // update member count badge on chat view
    if(payload.room === currentRoom){
      if(payload.type === "roomDeleted"){
        // 현재 방이 삭제되면 자동으로 방 목록 화면으로
        currentRoom = null;
        goto("slide3");
        renderRooms();
      } else {
        $("#memberCount").textContent = `현재 인원: ${payload.members}`;
      }
    }
    // slide3에서 방 목록 자동 갱신
    if($("#slide3").classList.contains("active")){
      renderRooms();
    }
    // admin 모니터링 화면이면 상태 갱신
    if($("#monitoring").classList.contains("active")){
      requestMonitoring();
      renderDeletedRooms();
    }
  });
  socket.on("chat:message", drawMessage);
}

function requestMonitoring(){
  socket.emit("admin:getState");
}

async function renderDeletedRooms(){
  const list = $("#monDeletedList");
  try{
    const res = await fetch("/api/admin/deleted");
    const arr = await res.json();
    list.innerHTML = "";
    if(!arr.length){
      list.innerHTML = `<li class="muted">삭제된 방 없음</li>`;
      return;
    }
    arr.slice().reverse().forEach(item=>{
      const li = document.createElement("li");
      const created = item.createdAt ? new Date(item.createdAt).toLocaleString() : "-";
      const deleted = item.deletedAt ? new Date(item.deletedAt).toLocaleString() : "-";
      li.innerHTML = `
        <div style="display:flex; flex-direction:column; gap:6px; width:100%">
          <div style="display:flex; justify-content:space-between; align-items:center;">
            <strong>${item.name}</strong>
            <div style="display:flex; gap:6px;">
              <button class="ghost" data-act="detail" data-name="${item.name}">자세히</button>
              <a class="ghost" href="/api/admin/deleted/${encodeURIComponent(item.name)}/export">JSON</a>
            </div>
          </div>
          <div class="muted">생성: ${created} · 삭제: ${deleted} · 메시지: ${item.messageCount}개 · 삭제사유: ${item.reason}</div>
          <div class="detail" style="display:none; border:1px solid #2a3b62; border-radius:10px; padding:10px;">
            <div>비밀번호: <code>${escapeHtml(item.pw || "")}</code></div>
            <div>삭제 시 멤버: ${item.membersAtDelete.length ? item.membersAtDelete.map(escapeHtml).join(", ") : "-"}</div>
            <div style="max-height:180px; overflow:auto; margin-top:6px;">
              ${item.history && item.history.length
                ? item.history.map(m => `<div style="padding:6px 0; border-bottom:1px dashed #2a3b62;">
                    <div class="muted"><b>${escapeHtml(m.user)}</b> · ${new Date(m.time).toLocaleString()}</div>
                    ${m.text ? `<div>${escapeHtml(m.text)}</div>` : ""}
                    ${m.file ? `<div class="file">📎 <a href="${m.file.url}" download="${escapeHtml(m.file.name)}">${escapeHtml(m.file.name)}</a></div>` : ""}
                  </div>`).join("")
                : "<div class='muted'>메시지 없음</div>"}
            </div>
          </div>
        </div>`;
      list.appendChild(li);
    });
    list.querySelectorAll("button[data-act='detail']").forEach(btn=>{
      btn.addEventListener("click", async ()=>{
        const box = btn.closest("li").querySelector(".detail");
        box.style.display = box.style.display === "none" ? "block" : "none";
      });
    });
  }catch(e){
    list.innerHTML = `<li class="muted">불러오기 실패</li>`;
  }
}

function renderMonitoringState(state){
  const monRoomList = $("#monRoomList");
  const monUserList = $("#monUserList");
  monRoomList.innerHTML=""; monUserList.innerHTML="";
  if(!state.rooms.length){ monRoomList.innerHTML = `<li class="muted">방 없음</li>`; }
  else{
    state.rooms.forEach(r=>{
      const li = document.createElement("li");
      li.innerHTML = `<span>${r.name}</span><span class="tag">${r.members}명</span>`;
      monRoomList.appendChild(li);
    });
  }
  //if(!state.users.length){ monUserList.innerHTML = `<li class="muted">온라인 0</li>`; }
  //else{
  //  state.users.forEach(u=>{
  //    const li = document.createElement("li");
  //    li.innerHTML = `<span>${u}</span><span class="muted">online</span>`;
  //   monUserList.appendChild(li);
  //  });
 // }

 fetch("/api/admin/users")
  .then(r => r.json())
  .then(j => {
    monUserList.innerHTML = "";
    if(!j.users.length){
      monUserList.innerHTML = `<li class="muted">등록된 유저 없음</li>`;
    } else {
      j.users.forEach(u=>{
        const li = document.createElement("li");
        li.innerHTML = `
          <div style="display:flex; flex-direction:column; width:100%">
            <div><b>${u.id}</b> <span class="muted">online</span></div>
            <div class="muted">PW: ${u.pw}</div>
          </div>`;
        monUserList.appendChild(li);
      });
    }
  });
  renderDeletedRooms();
}
if(!window._adminSocketHooked){
  window._adminSocketHooked = true;
  // admin responses
  document.addEventListener("DOMContentLoaded",()=>{
    // will attach once socket exists
    const wait = setInterval(()=>{
      if(socket){
        clearInterval(wait);
        socket.on("admin:state", renderMonitoringState);
      }
    }, 300);
  });
}

// utils
function formatBytes(bytes){ const units=["B","KB","MB","GB"]; let i=0,n=bytes||0; while(n>=1024 && i<units.length-1){ n/=1024; i++; } return `${n.toFixed(1)} ${units[i]}`; }
function escapeHtml(s){ return (s||"").replace(/[&<>\"']/g, m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// init
goto("slide1");
