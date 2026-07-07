import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { api, type Grievance, type TraceStep, type Citation, type AutomationView } from "./api";
import { sttSupported, listenOnce, speak, stopSpeaking, recorderSupported, startRecording, transcribeViaServer } from "./voice";

type ChatMsg = { role: "user" | "assistant"; text: string; trace?: TraceStep[]; intent?: string; citations?: Citation[]; lang?: string };
type Tab = "grievances" | "automation" | "documents" | "insights" | "alerts";

export default function App() {
  const [health, setHealth] = useState<any>(null);
  const [grievances, setGrievances] = useState<Grievance[]>([]);
  const [rtiView, setRtiView] = useState<Grievance | null>(null);
  const [tab, setTab] = useState<Tab>("grievances");
  const [alertCount, setAlertCount] = useState(0);

  const refresh = () => api.grievances().then(setGrievances).catch(() => {});
  useEffect(() => {
    api.health().then(setHealth).catch(() => {});
    refresh();
    api.notifications().then((n) => setAlertCount(n.length)).catch(() => {});
    const t = setInterval(() => { refresh(); api.notifications().then((n) => setAlertCount(n.length)).catch(() => {}); }, 5000);
    return () => clearInterval(t);
  }, []);

  const tabs: [Tab, string][] = [
    ["grievances", "Grievances"], ["automation", "Automation"], ["documents", "Documents"],
    ["insights", "Insights"], ["alerts", `Alerts${alertCount ? ` (${alertCount})` : ""}`],
  ];
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const onTabKey = (e: ReactKeyboardEvent) => {
    const i = tabs.findIndex(([id]) => id === tab);
    let n = -1;
    if (e.key === "ArrowRight") n = (i + 1) % tabs.length;
    else if (e.key === "ArrowLeft") n = (i - 1 + tabs.length) % tabs.length;
    else if (e.key === "Home") n = 0;
    else if (e.key === "End") n = tabs.length - 1;
    if (n >= 0) { e.preventDefault(); setTab(tabs[n][0]); tabRefs.current[n]?.focus(); }
  };

  return (
    <div className="app">
      <a href="#main" className="skip-link">Skip to content</a>
      <header>
        <div>
          <h1><span aria-hidden="true">🇮🇳</span> Smart Bharat</h1>
          <p className="tag">Multi-agent civic companion · orchestrator · RAG · ombudsman · automation</p>
        </div>
        {health && (
          <div className="badges">
            <span className={"pill " + (health.llm === "groq" ? "ok" : "warn")}>LLM: {health.llm}</span>
            <span className={"pill " + (health.db === "mongodb" ? "ok" : "warn")}>DB: {health.db}</span>
            <span className={"pill " + (health.voice === "elevenlabs" ? "ok" : "warn")}>Voice: {health.voice}</span>
            <span className="pill">RAG: {health.rag_chunks} chunks</span>
            <span className="pill">{health.schemes} schemes</span>
          </div>
        )}
      </header>

      <main id="main" className="grid">
        <div className="col-left">
          <ChatPanel onChanged={refresh} serverStt={health?.voice === "elevenlabs"} />
          <PhotoPanel onFiled={refresh} />
        </div>

        <div className="col-right card">
          <div className="tabs" role="tablist" aria-label="Panels">
            {tabs.map(([id, label], idx) => (
              <button
                key={id}
                ref={(el) => { tabRefs.current[idx] = el; }}
                role="tab"
                id={`tab-${id}`}
                aria-selected={tab === id}
                aria-controls={`panel-${id}`}
                tabIndex={tab === id ? 0 : -1}
                className={"tab " + (tab === id ? "active" : "")}
                onClick={() => setTab(id)}
                onKeyDown={onTabKey}
              >{label}</button>
            ))}
          </div>
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} tabIndex={0}>
            {tab === "grievances" && <GrievancePanel grievances={grievances} onChange={refresh} onViewRti={setRtiView} />}
            {tab === "automation" && <AutomationPanel />}
            {tab === "documents" && <DocumentsPanel />}
            {tab === "insights" && <InsightsPanel />}
            {tab === "alerts" && <AlertsPanel onCount={setAlertCount} />}
          </div>
        </div>
      </main>

      {rtiView?.rti_draft && <RtiModal g={rtiView} onClose={() => setRtiView(null)} onSubmit={refresh} />}
    </div>
  );
}

// ---------- Chat ----------
function ChatPanel({ onChanged, serverStt }: { onChanged: () => void; serverStt: boolean }) {
  const [msgs, setMsgs] = useState<ChatMsg[]>([
    { role: "assistant", text: "Namaste! Ask me about a scheme, file a complaint, or say 'which schemes am I eligible for'. Try Hinglish too." },
  ]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [scheme, setScheme] = useState(false);
  const [voiceOut, setVoiceOut] = useState(false); // speak replies aloud
  const [listening, setListening] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [liveErr, setLiveErr] = useState(""); // announced via an assertive live region
  const [sttLang, setSttLang] = useState("en-IN");
  const stopRef = useRef<() => void>(() => {}); // browser Web Speech stop
  const recStopRef = useRef<null | (() => Promise<Blob>)>(null); // Scribe recorder stop
  const useScribe = serverStt && recorderSupported();
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }, [msgs]);
  useEffect(() => {
    return () => {
      stopSpeaking();
    };
  }, []);

  const send = async (preset?: string, spoken = false) => {
    const message = (preset ?? input).trim();
    if (!message || busy) return;
    setInput("");
    setMsgs((m) => [...m, { role: "user", text: message }]);
    setBusy(true);
    const useVoice = spoken || voiceOut;
    try {
      const r = useVoice ? await api.voiceChat(message) : await api.chat(message);
      setScheme(r.schemeActive);
      setMsgs((m) => [...m, { role: "assistant", text: r.reply, trace: r.trace, intent: r.intent?.intent, citations: r.citations, lang: r.intent?.language }]);
      if (useVoice) {
        const v = r as import("./api").VoiceChatResult;
        setSpeaking(true);
        speak(v.audioBase64, v.audioContentType, r.reply, r.intent?.language ?? "en", () => setSpeaking(false));
      }
      onChanged();
    } catch (e: any) {
      setLiveErr(e.message);
      setMsgs((m) => [...m, { role: "assistant", text: "⚠️ " + e.message }]);
    } finally { setBusy(false); }
  };

  const err = (text: string) => { setLiveErr(text); setMsgs((m) => [...m, { role: "assistant", text: "⚠️ " + text }]); };

  const mic = async () => {
    // --- stop path ---
    if (listening) {
      setListening(false);
      if (recStopRef.current) {
        // Scribe: stop recording, upload, transcribe, then send.
        try {
          const blob = await recStopRef.current();
          recStopRef.current = null;
          setTranscribing(true);
          const res = await transcribeViaServer(blob);
          setTranscribing(false);
          if (res === null) return err("Voice input unavailable right now — please type instead.");
          if (res.text) await send(res.text, true);
          else err("Didn't catch that — try again.");
        } catch (e: any) {
          setTranscribing(false);
          err(e.message || "couldn't transcribe that");
        }
      } else {
        stopRef.current(); // browser Web Speech resolves via its promise below
      }
      return;
    }
    // --- start path ---
    stopSpeaking();
    if (useScribe) {
      try {
        const { stop } = await startRecording();
        recStopRef.current = stop;
        setListening(true);
      } catch {
        err("Mic permission denied. Allow microphone access to use voice.");
      }
      return;
    }
    if (!sttSupported()) return err("Voice input needs Chrome or Edge (Web Speech API).");
    setListening(true);
    try {
      const { promise, stop } = listenOnce(sttLang);
      stopRef.current = stop;
      const transcript = await promise;
      setListening(false);
      if (transcript) await send(transcript, true); // spoken input -> spoken reply
    } catch (e: any) {
      setListening(false);
      err(e.message || "couldn't hear that");
    }
  };

  return (
    <section className="card chat">
      <h2>Chat · Orchestrator {scheme && <span className="pill warn small">slot-filling</span>}</h2>
      <div className="voice-ctrls" role="toolbar" aria-label="Voice controls">
        {useScribe ? (
          <span className="pill ok small" title="ElevenLabs Scribe: auto-detects Hindi/English & code-switching">Scribe</span>
        ) : (
          <select value={sttLang} onChange={(e) => setSttLang(e.target.value)} aria-label="Speech-input language" disabled={busy}>
            <option value="en-IN">EN/Hinglish</option>
            <option value="hi-IN" lang="hi">हिंदी</option>
          </select>
        )}
        <button className={"mic " + (listening ? "on" : "")} onClick={mic} disabled={busy || transcribing} aria-pressed={listening} aria-label="Speak your message">
          {transcribing ? "… transcribing" : listening ? (useScribe ? <><span aria-hidden="true">● </span>stop &amp; send</> : <><span aria-hidden="true">● </span>listening…</>) : <span aria-hidden="true">🎙️</span>}
        </button>
        <label className="spk">
          <input type="checkbox" checked={voiceOut} aria-label="Speak replies aloud" onChange={(e) => { setVoiceOut(e.target.checked); if (!e.target.checked) stopSpeaking(); }} /> <span aria-hidden="true">🔊</span>
        </label>
      </div>
      {/* Visually-hidden live regions: state changes + errors announced to AT. */}
      <span className="sr-only" aria-live="polite">
        {transcribing ? "Transcribing" : listening ? "Listening" : speaking ? "Playing response" : ""}
      </span>
      <span className="sr-only" role="alert" aria-live="assertive">{liveErr}</span>
      <div className="chips">
        {["how much does PM-KISAN pay?", "which schemes am I eligible for", "there is a huge pothole near MG road", "mera complaint ka status kya hai"].map((c) => (
          <button key={c} className="chip" onClick={() => send(c)} disabled={busy}>{c}</button>
        ))}
      </div>
      <div className="msgs" role="log" aria-live="polite" aria-relevant="additions" aria-atomic="false" aria-busy={busy}>
        {msgs.map((m, i) => (
          <div key={i} className={"msg " + m.role}>
            <div className="bubble" lang={m.lang === "hi" ? "hi" : undefined}>{m.text}</div>
            {m.citations && m.citations.length > 0 && (
              <ul className="cites" role="list">
                {m.citations.map((c) => (
                  <li key={c.n}>
                    <a className={"cite " + (c.stale ? "stale" : "")} href={c.source_url} target="_blank" rel="noreferrer" title={c.snippet}>
                      [{c.n}] {c.title}{c.stale ? " ⚠️" : ""}<span className="sr-only"> (opens in new tab)</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {m.trace && (
              <details className="trace">
                <summary>🧭 agent trace{m.intent ? ` · ${m.intent}` : ""}</summary>
                {m.trace.map((t, k) => (<div key={k} className="tstep"><b>{t.node}</b> — {t.detail}</div>))}
              </details>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>
      <div className="row">
        <input value={input} aria-label="Message" placeholder="Type in English, हिंदी, or Hinglish…" onChange={(e) => setInput(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} />
        <button className="primary" onClick={() => send()} disabled={busy}>{busy ? "…" : "Send"}</button>
      </div>
    </section>
  );
}

// ---------- Photo ----------
function PhotoPanel({ onFiled }: { onFiled: () => void }) {
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<any>(null);
  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setResult(null);
    try { setResult(await api.photo(file, note)); onFiled(); }
    catch (e: any) { setResult({ error: e.message }); }
    finally { setBusy(false); }
  };
  return (
    <section className="card">
      <h2>Photo → Complaint</h2>
      <input className="note" aria-label="Optional note or location" placeholder="optional note / location" value={note} onChange={(e) => setNote(e.target.value)} />
      <input id="photo-file" className="sr-only" type="file" accept="image/*" aria-label="Upload civic-issue photo" onChange={(e) => onFile(e.target.files?.[0])} />
      <label className="filebtn" htmlFor="photo-file">{busy ? "Analyzing…" : <><span aria-hidden="true">📷 </span>Upload civic-issue photo</>}</label>
      {result?.classification && (
        <div className="result">
          <div><b>{result.classification.category}</b> · severity <b>{result.classification.severity}</b></div>
          <div className="muted small">{result.classification.severity_reason}</div>
          {result.filed ? <div className="ok-text">✓ Filed as {result.grievance._id}</div> : <div className="warn-text">Not filed: {result.message}</div>}
        </div>
      )}
      {result?.error && <div className="warn-text">⚠️ {result.error}</div>}
    </section>
  );
}

// ---------- Grievances ----------
function GrievancePanel({ grievances, onChange, onViewRti }: { grievances: Grievance[]; onChange: () => void; onViewRti: (g: Grievance) => void }) {
  const ff = async (id: string) => { await api.fastForward(id); onChange(); };
  return (
    <div>
      <p className="muted small">Complaints filed via chat or photo. Fast-forward simulates the SLA clock so escalation → RTI is visible instantly.</p>
      {grievances.length === 0 && <p className="muted">No complaints yet.</p>}
      <ul className="glist" role="list">
        {grievances.map((g) => (
          <li key={g._id} className={"gitem sev-" + g.severity}>
            <div className="ghead"><span className="gtitle">{g.title}</span><StatusPill g={g} /></div>
            <div className="muted small">{g.department.replace(/_/g, " ")} · {g._id} · due {new Date(g.sla_deadline).toLocaleString()}</div>
            <div className="escbar"><Dot on label="Filed" /><Dot on={g.escalation_level >= 1} label="L1 Follow-up" /><Dot on={g.escalation_level >= 2} label="L2 RTI" /></div>
            <div className="gactions">
              {g.status !== "rti_drafted" && g.status !== "resolved" && <button className="ghost" onClick={() => ff(g._id)}><span aria-hidden="true">⏩ </span>Fast-forward SLA</button>}
              {g.rti_draft && <button className="primary" onClick={() => onViewRti(g)}>{g.rti_draft.submitted_by_user ? "✓ RTI submitted — view" : <><span aria-hidden="true">📄 </span>Review RTI draft</>}</button>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
function StatusPill({ g }: { g: Grievance }) {
  const map: Record<string, string> = { open: "pill", follow_up_sent: "pill warn", rti_drafted: "pill danger", resolved: "pill ok", closed: "pill" };
  return <span className={map[g.status] || "pill"}>{g.status.replace(/_/g, " ")}</span>;
}
function Dot({ on, label }: { on?: boolean; label: string }) { return <span className={"dot " + (on ? "on" : "")}><span aria-hidden="true">●</span> <span>{label}{on ? " (done)" : ""}</span></span>; }

// ---------- Automation (human-in-the-loop) ----------
function AutomationPanel() {
  const [services, setServices] = useState<any[]>([]);
  const [run, setRun] = useState<AutomationView | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  useEffect(() => { api.automationServices().then(setServices).catch(() => {}); }, []);

  const start = async (id: string) => { setBusy(true); try { setRun(await api.automationStart(id)); } finally { setBusy(false); } };
  const resume = async () => { if (!run) return; setBusy(true); try { setRun(await api.automationResume(run.runId, note || "done")); setNote(""); } finally { setBusy(false); } };

  return (
    <div>
      <p className="muted small">Agentic browser automation with human-in-the-loop. The agent fills non-secret fields; <b>you</b> handle login, OTP, and final submit. The graph literally pauses (LangGraph <code>interrupt()</code>) and resumes on your confirmation.</p>
      {!run && (
        <ul className="svc-list" role="list">
          {services.map((s) => (
            <li key={s.service_id}>
              <button className="svc" disabled={busy} onClick={() => start(s.service_id)}>
                <b>{s.service_id.replace(/_/g, " ")}</b>
                <span className="muted small">{s.steps} steps · {s.required_docs.join(", ")}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {run && (
        <div className="automation">
          <div className="progress">
            Step {run.step_index}/{run.total_steps} · <b>{run.status}</b>
            <span className={"pill small " + (run.mode === "live" ? "ok" : "warn")} style={{ marginLeft: 8 }}>
              {run.mode === "live" ? "🌐 live browser" : "simulation"}
            </span>
          </div>
          {run.mode === "live" && run.status === "paused" && (
            <div className="muted small">A real Chromium window is open — do the login/OTP <b>there</b>, then click continue below.</div>
          )}
          {run.screenshot && <img className="shot" src={run.screenshot} alt={`Browser at step ${run.step_index}, status ${run.status}`} />}
          {run.status === "paused" && run.interrupt && (
            <div className="turn">
              <div className="turn-h">🙋 Your turn: {run.interrupt.reason}</div>
              <div className="muted small">{run.interrupt.instruction}</div>
              {run.interrupt.portal && <a className="muted small" href={run.interrupt.portal} target="_blank" rel="noreferrer">{run.interrupt.portal}<span className="sr-only"> (opens in new tab)</span></a>}
              <div className="row">
                <input aria-label="Note for automation step" placeholder="optional note (e.g. 'done')" value={note} onChange={(e) => setNote(e.target.value)} />
                <button className="primary" disabled={busy} onClick={resume}>✅ I've done this — continue</button>
              </div>
            </div>
          )}
          {run.status === "done" && <div className="ok-text">✓ Flow complete. The agent never entered your OTP, password, or hit final submit.</div>}
          <details className="trace" open><summary>step log</summary>
            {run.log.map((l) => <div key={l.index} className="tstep"><b>{l.type}</b> — {l.detail}</div>)}
          </details>
          <button className="ghost" onClick={() => setRun(null)}>← back to services</button>
        </div>
      )}
    </div>
  );
}

// ---------- Documents ----------
function DocumentsPanel() {
  const [services, setServices] = useState<any[]>([]);
  const [svc, setSvc] = useState("aadhaar_update");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<any>(null);
  useEffect(() => { api.services().then((s) => { setServices(s); if (s[0]) setSvc(s[0].id); }).catch(() => {}); }, []);
  const onFile = async (file?: File) => {
    if (!file) return;
    setBusy(true); setRes(null);
    try { setRes(await api.documentCheck(file, svc)); } catch (e: any) { setRes({ error: e.message }); } finally { setBusy(false); }
  };
  return (
    <div>
      <p className="muted small">Upload a document; the vision model extracts its fields and checks what's still missing for a service. ID numbers are redacted (last 4 only).</p>
      <select value={svc} aria-label="Service to check documents for" onChange={(e) => setSvc(e.target.value)}>
        {services.map((s) => <option key={s.id} value={s.id}>{s.label} — needs {s.required_docs.join(", ")}</option>)}
      </select>
      <input id="doc-file" className="sr-only" type="file" accept="image/*" aria-label="Upload document" onChange={(e) => onFile(e.target.files?.[0])} />
      <label className="filebtn" htmlFor="doc-file" style={{ marginTop: 10 }}>{busy ? "Reading…" : <><span aria-hidden="true">📄 </span>Upload document</>}</label>
      {res?.extracted && (
        <div className="result">
          <div>Detected: <b>{res.extracted.doc_type}</b> {res.extracted.holder_name ? `· ${res.extracted.holder_name}` : ""} {res.extracted.id_number ? `· ${res.extracted.id_number}` : ""}</div>
          {res.matched_requirement ? <div className="ok-text">✓ Satisfies “{res.matched_requirement}”.</div> : <div className="warn-text">This doc isn't in the required list for the service.</div>}
          <div className="muted small" style={{ marginTop: 6 }}>{res.still_missing?.length ? `Still missing: ${res.still_missing.join(", ")}` : "All required documents are on file ✓"}</div>
        </div>
      )}
      {res?.error && <div className="warn-text">⚠️ {res.error}</div>}
    </div>
  );
}

// ---------- Insights / Transparency ----------
function InsightsPanel() {
  const [t, setT] = useState<any>(null);
  useEffect(() => { const load = () => api.transparency().then(setT).catch(() => {}); load(); const iv = setInterval(load, 5000); return () => clearInterval(iv); }, []);
  if (!t) return <p className="muted">Loading…</p>;
  return (
    <div>
      <div className="summary-card">{t.summary}</div>
      <div className="stat-row">
        <Stat label="Total" v={t.total} /><Stat label="SLA met" v={t.sla.compliance_pct + "%"} good={t.sla.compliance_pct >= 70} />
        <Stat label="L1 follow-ups" v={t.escalations.l1_follow_up} /><Stat label="RTIs drafted" v={t.escalations.l2_rti} bad={t.escalations.l2_rti > 0} />
      </div>
      <h3 className="mini">By department</h3>
      {t.by_department.map((d: any) => (
        <div key={d.department} className="bar-row">
          <span className="bar-label">{d.department.replace(/_/g, " ")}</span>
          <span className="bar"><span className="bar-fill" style={{ width: `${Math.round((d.resolved / Math.max(d.total, 1)) * 100)}%` }} /></span>
          <span className="muted small">{d.resolved}/{d.total} resolved</span>
        </div>
      ))}
    </div>
  );
}
function Stat({ label, v, good, bad }: { label: string; v: any; good?: boolean; bad?: boolean }) {
  return <div className={"stat " + (good ? "g" : bad ? "b" : "")}><div className="stat-v">{v}</div><div className="muted small">{label}</div></div>;
}

// ---------- Alerts / Nudges ----------
function AlertsPanel({ onCount }: { onCount: (n: number) => void }) {
  const [items, setItems] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const load = () => api.notifications().then((n) => { setItems(n); onCount(n.length); }).catch(() => {});
  useEffect(() => { load(); }, []);
  const scan = async () => { setBusy(true); try { await api.nudgeScan(); await load(); } finally { setBusy(false); } };
  return (
    <div>
      <p className="muted small">Proactive Nudge agent scans your profile for schemes you likely qualify for. Set your profile (Documents tab flow / API) and run a scan.</p>
      <button className="ghost" onClick={scan} disabled={busy}>{busy ? "Scanning…" : "🔔 Run nudge scan now"}</button>
      {items.length === 0 && <p className="muted small" style={{ marginTop: 10 }}>No alerts yet. Nudges appear after your profile has age, occupation, income, category & state.</p>}
      <ul className="glist" role="list" style={{ marginTop: 10 }}>
        {items.map((n) => (
          <li key={n._id} className="gitem"><div className="gtitle">{n.title}</div><div className="muted small">{n.body}</div></li>
        ))}
      </ul>
    </div>
  );
}

// ---------- RTI modal ----------
function RtiModal({ g, onClose, onSubmit }: { g: Grievance; onClose: () => void; onSubmit: () => void }) {
  const [busy, setBusy] = useState(false);
  const submitted = g.rti_draft!.submitted_by_user;
  const submit = async () => { setBusy(true); try { await api.submitRti(g._id); onSubmit(); onClose(); } finally { setBusy(false); } };

  const dialogRef = useRef<HTMLDivElement>(null);
  // Keep a ref to the latest onClose so the mount-once effect never restarts
  // (the parent re-renders on a 5s interval and passes a fresh onClose each time).
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null; // restore focus here on close
    const dlg = dialogRef.current;
    const focusables = () =>
      dlg ? Array.from(dlg.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
      )).filter((el) => !el.hasAttribute("disabled")) : [];
    (focusables()[0] ?? dlg)?.focus(); // move focus into the dialog on open
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onCloseRef.current(); return; }
      if (e.key !== "Tab") return;
      const f = focusables();
      if (f.length === 0) { e.preventDefault(); return; }
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("keydown", onKey); prev?.focus?.(); };
  }, []);

  return (
    <div className="modal-bg" onClick={onClose}>
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="rti-title" ref={dialogRef} tabIndex={-1} onClick={(e) => e.stopPropagation()}>
        <h3 id="rti-title">RTI Application — auto-drafted</h3>
        <p className="muted small">Auto-generated because this complaint stayed unresolved past escalation L1. Nothing is submitted until <b>you</b> click submit.</p>
        <div className="rti">
          <div><b>To:</b> {g.rti_draft!.public_authority}</div>
          <div><b>Subject:</b> {g.rti_draft!.subject}</div>
          <pre>{g.rti_draft!.body}</pre>
        </div>
        <div className="row end">
          <button className="ghost" onClick={onClose}>Close</button>
          {submitted ? <span className="ok-text">✓ Submitted by you</span> : <button className="primary" disabled={busy} onClick={submit}>{busy ? "…" : "✅ I confirm — submit RTI"}</button>}
        </div>
      </div>
    </div>
  );
}
