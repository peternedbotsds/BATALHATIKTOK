// ============================================================
//  SERVIDOR DA BATALHA DE PRESENTES - TikTok LIVE
//  Conecta na sua live pelo @, recebe os presentes e manda
//  para a página do jogo (batalha-tiktok.html) via WebSocket.
// ============================================================
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as TLC from "tiktok-live-connector";

// ----------------- CONFIGURAÇÕES (edite aqui) -----------------
const USUARIO = (process.env.TIKTOK_USER || "mendeescriolo").replace(/^@/, ""); // seu @ (sem o @)
const PORTA = Number(process.env.PORT || 3000);          // porta do site local
const HOST = process.env.HOST || "0.0.0.0";              // Railway precisa escutar em todas as interfaces
const TENTAR_DE_NOVO_MS = 10000;                         // espera antes de reconectar
const MOSTRAR_EVENTO_BRUTO = process.env.DEBUG === "1";  // DEBUG=1 mostra o evento completo no terminal
const ARQUIVO_JOGO = "batalha-tiktok.html";
// ---------------------------------------------------------------

const pasta = path.dirname(fileURLToPath(import.meta.url));
const lib = { ...(TLC.default || {}), ...TLC };
const Conexao = lib.TikTokLiveConnection || lib.WebcastPushConnection;
const EVT_GIFT = lib.WebcastEvent?.GIFT ?? "gift";
if (!Conexao) {
  console.error("Não achei a classe de conexão em tiktok-live-connector. Rode: npm install");
  process.exit(1);
}

// ---------- servidor web (entrega o jogo) ----------
const servidor = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Teste sem live: http://localhost:3000/teste?gift=Rose&n=1
  if (url.pathname === "/teste") {
    const nome = url.searchParams.get("gift") || "Rose";
    const n = Math.max(1, parseInt(url.searchParams.get("n") || "1", 10) || 1);
    enviar({
      event: "gift",
      data: {
        giftName: nome, repeatCount: n, repeatEnd: true, giftType: 0,
        uniqueId: "teste", nickname: url.searchParams.get("user") || "Teste", profilePictureUrl: ""
      }
    });
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Presente de teste enviado: ${nome} x${n}`);
    return;
  }

  if (url.pathname === "/" || url.pathname === "/" + ARQUIVO_JOGO) {
    fs.readFile(path.join(pasta, ARQUIVO_JOGO), (err, html) => {
      if (err) {
        res.writeHead(500, { "Content-Type": "text/plain; charset=utf-8" });
        res.end(`Não achei ${ARQUIVO_JOGO} na mesma pasta do server.js`);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(html);
    });
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Não encontrado");
});

// ---------- WebSocket (manda os eventos para o jogo) ----------
const wss = new WebSocketServer({ server: servidor });
wss.on("connection", () => console.log(`[jogo] página conectada (${wss.clients.size} aberta(s))`));

function enviar(obj) {
  const texto = JSON.stringify(obj);
  wss.clients.forEach((c) => { if (c.readyState === 1) c.send(texto); });
}

// ---------- tradução do evento do TikTok para um formato simples ----------
const primeiro = (...v) => v.find((x) => x !== undefined && x !== null && x !== "");

function normalizarPresente(d) {
  const u = d.user || {};
  const info = d.extendedGiftInfo || d.giftDetails || {};
  const foto = primeiro(
    d.profilePictureUrl,
    u.profilePicture?.url?.[0],
    u.avatarLarge?.urlList?.[0],
    u.avatarThumb?.urlList?.[0],
    u.avatarMedium?.urlList?.[0]
  );
  return {
    giftName: primeiro(d.giftName, info.name, info.giftName, ""),
    giftId: d.giftId != null ? String(d.giftId) : undefined,
    giftType: primeiro(d.giftType, info.type),             // 1 = presente que aceita combo
    repeatCount: Number(primeiro(d.repeatCount, 1)),
    repeatEnd: d.repeatEnd === true || d.repeatEnd === 1 || d.repeatEnd === "1",
    diamondCount: primeiro(d.diamondCount, info.diamond_count, info.diamondCount),
    uniqueId: String(primeiro(u.uniqueId, d.uniqueId, u.userId, d.userId, "")),
    nickname: String(primeiro(u.nickname, d.nickname, u.uniqueId, d.uniqueId, "Alguém")),
    profilePictureUrl: foto || ""
  };
}

// resume o erro da biblioteca em uma linha legível
function resumoErro(e) {
  const causa = e?.exception?.message || e?.message;
  return [e?.info, causa].filter(Boolean).filter((x, i, a) => a.indexOf(x) === i).join(" - ") || String(e);
}

// ---------- conexão com a live ----------
let conexao = null;
let reconectando = false;

function agendarNovaTentativa(motivo) {
  if (reconectando) return;
  reconectando = true;
  console.log(`[tiktok] ${motivo} Nova tentativa em ${TENTAR_DE_NOVO_MS / 1000}s...`);
  setTimeout(() => { reconectando = false; conectar(); }, TENTAR_DE_NOVO_MS);
}

async function conectar() {
  try { conexao?.disconnect?.(); } catch { /* ignora */ }
  conexao = new Conexao(USUARIO, { enableExtendedGiftInfo: true });

  conexao.on(EVT_GIFT, (data) => {
    if (MOSTRAR_EVENTO_BRUTO) console.log("[bruto]", JSON.stringify(data, (k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 2000));
    const g = normalizarPresente(data);
    console.log(`[presente] ${g.nickname}: ${g.giftName || "(sem nome, id " + g.giftId + ")"} x${g.repeatCount}${g.repeatEnd ? " (fim)" : ""}`);
    enviar({ event: "gift", data: g });
  });

  conexao.on("disconnected", () => agendarNovaTentativa("Desconectado da live."));
  conexao.on("streamEnd", () => agendarNovaTentativa("A live terminou."));
  conexao.on("error", (e) => console.log("[tiktok] erro:", resumoErro(e)));

  try {
    console.log(`[tiktok] conectando em @${USUARIO}...`);
    const estado = await conexao.connect();
    console.log(`[tiktok] conectado! sala ${estado?.roomId ?? ""}`);
    reconectando = false;
  } catch (e) {
    agendarNovaTentativa(`Não conectou (${resumoErro(e)}). A live precisa estar no ar.`);
  }
}

servidor.listen(PORTA, HOST, () => {
  console.log("============================================");
  console.log(` Jogo:   http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORTA}/`);
  console.log(` Teste:  http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORTA}/teste?gift=Rose&n=1`);
  console.log(` Live:   @${USUARIO}`);
  console.log("============================================");
  conectar();
});

process.on("unhandledRejection", (e) => console.log("[aviso]", resumoErro(e)));
