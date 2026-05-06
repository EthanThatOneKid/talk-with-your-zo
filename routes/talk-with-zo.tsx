import { useMemo, useRef, useState } from "react";
import { Bot, Eraser, Mic, MicOff, Send, Volume2, VolumeX } from "lucide-react";

type AskState = "idle" | "listening" | "preparing" | "asking" | "speaking" | "error";

type SpeechRecognitionLike = {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start: () => void;
  stop: () => void;
  abort?: () => void;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
};

type SpeechRecognitionEventLike = {
  resultIndex: number;
  results: ArrayLike<{
    isFinal: boolean;
    0: { transcript: string };
  }>;
};

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  }
}

const redactPatterns = [
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi,
  /\b(?:\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  /\b\d{3}-\d{2}-\d{4}\b/g,
];

function preparePrompt(input: string) {
  return redactPatterns.reduce((text, pattern) => text.replace(pattern, "[redacted]"), input).trim();
}

function extractTextFromEvent(eventText: string) {
  const lines = eventText.split(/\r?\n/);
  const eventName = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
  let text = "";

  for (const line of lines) {
    if (!line.startsWith("data:")) continue;
    const raw = line.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;

    try {
      const parsed = JSON.parse(raw);
      if (eventName === "PartStartEvent" && parsed.part?.part_kind === "text" && typeof parsed.part.content === "string") {
        text += parsed.part.content;
      } else if (!eventName && typeof parsed.delta === "string") text += parsed.delta;
      else if (!eventName && typeof parsed.output === "string") text += parsed.output;
      else if (!eventName && typeof parsed.text === "string") text += parsed.text;
      else if (!eventName && typeof parsed.message === "string") text += parsed.message;
      else if (eventName === "End") text += "";
    } catch {
      text += raw;
    }
  }

  return text;
}

export default function TalkWithZo() {
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const [state, setState] = useState<AskState>("idle");
  const [transcript, setTranscript] = useState("");
  const [interimTranscript, setInterimTranscript] = useState("");
  const [preparedPrompt, setPreparedPrompt] = useState("");
  const [response, setResponse] = useState("");
  const [error, setError] = useState("");
  const [voiceEnabled, setVoiceEnabled] = useState(true);

  const speechSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  }, []);

  const ttsSupported = useMemo(() => {
    if (typeof window === "undefined") return false;
    return "speechSynthesis" in window;
  }, []);

  function stopListening() {
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    setState("idle");
  }

  function startListening() {
    setError("");

    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setError("Speech recognition is not available in this browser.");
      setState("error");
      return;
    }

    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onresult = (event) => {
      let finalText = "";
      let interimText = "";

      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0]?.transcript || "";
        if (result.isFinal) finalText += text;
        else interimText += text;
      }

      if (finalText) {
        setTranscript((current) => `${current} ${finalText}`.trim());
      }
      setInterimTranscript(interimText.trim());
    };

    recognition.onerror = (event) => {
      setError(event.error || "Speech recognition failed.");
      setState("error");
    };

    recognition.onend = () => {
      recognitionRef.current = null;
      setInterimTranscript("");
      setState((current) => current === "listening" ? "idle" : current);
    };

    recognitionRef.current = recognition;
    recognition.start();
    setState("listening");
  }

  function speak(text: string) {
    if (!voiceEnabled || !ttsSupported || !text) {
      setState("idle");
      return;
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 0.98;
    utterance.pitch = 1;
    setState("speaking");
    utterance.onend = () => setState("idle");
    window.speechSynthesis.speak(utterance);
    window.setTimeout(() => setState((current) => current === "speaking" ? "idle" : current), 12000);
  }

  async function askZo() {
    const prompt = preparePrompt(`${transcript} ${interimTranscript}`.trim());
    if (!prompt) {
      setError("Say or type something first.");
      setState("error");
      return;
    }

    recognitionRef.current?.stop();
    window.speechSynthesis?.cancel();
    setPreparedPrompt(prompt);
    setResponse("");
    setError("");
    setState("preparing");

    try {
      setState("asking");
      const result = await fetch("/api/talk-with-zo", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Accept": "text/event-stream, application/json",
        },
        body: JSON.stringify({ input: prompt, stream: true }),
      });

      if (!result.ok) {
        const detail = await result.text();
        throw new Error(detail || `Zo API request failed with ${result.status}`);
      }

      const reader = result.body?.getReader();
      if (!reader) {
        const json = await result.json();
        const output = json.output || json.text || "";
        setResponse(output);
        speak(output);
        return;
      }

      const decoder = new TextDecoder();
      let fullText = "";
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split(/\n\n|\r\n\r\n/);
        buffer = events.pop() || "";

        for (const eventText of events) {
          const delta = extractTextFromEvent(eventText);
          fullText += delta;
        }

        setResponse(fullText);
      }

      if (buffer.trim()) {
        fullText += extractTextFromEvent(buffer);
        setResponse(fullText);
      }

      if (/^Error:/i.test(fullText.trim())) {
        throw new Error(fullText.trim());
      }

      speak(fullText);
      if (!voiceEnabled) setState("idle");
    } catch (err) {
      setResponse("");
      setError(err instanceof Error ? err.message : "Zo request failed.");
      setState("error");
    }
  }

  function reset() {
    recognitionRef.current?.abort?.();
    window.speechSynthesis?.cancel();
    setTranscript("");
    setInterimTranscript("");
    setPreparedPrompt("");
    setResponse("");
    setError("");
    setState("idle");
  }

  const liveTranscript = `${transcript}${interimTranscript ? ` ${interimTranscript}` : ""}`.trim();

  return (
    <main className="min-h-screen bg-[#f6f1e7] text-[#141311]">
      <section className="mx-auto flex min-h-screen w-full max-w-5xl flex-col px-5 py-6 sm:px-8 lg:px-10">
        <header className="flex items-center justify-between gap-4 border-b border-[#141311]/15 pb-5">
          <div className="flex items-center gap-3">
            <div className="grid h-11 w-11 place-items-center rounded-full bg-[#141311] text-[#f6f1e7]">
              <Bot className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm uppercase tracking-[0.22em] text-[#5f5a50]">Zo Space demo</p>
              <h1 className="text-2xl font-semibold sm:text-3xl">Talk with your Zo</h1>
            </div>
          </div>
          <div className="rounded-full border border-[#141311]/15 px-3 py-1 text-sm text-[#5f5a50]">
            {state}
          </div>
        </header>

        <div className="grid flex-1 gap-5 py-6 lg:grid-cols-[0.95fr_1.05fr]">
          <section className="flex flex-col gap-4 rounded-lg border border-[#141311]/15 bg-white/55 p-4 shadow-sm">
            <label className="text-sm font-medium uppercase tracking-[0.18em] text-[#5f5a50]">
              Your voice
            </label>
            <textarea
              value={liveTranscript}
              onChange={(event) => setTranscript(event.target.value)}
              placeholder={speechSupported ? "Press the mic and start talking..." : "Type here; speech recognition is unavailable in this browser."}
              className="min-h-[260px] flex-1 resize-none rounded-md border border-[#141311]/15 bg-[#fffaf0] p-4 text-lg leading-7 outline-none focus:border-[#1f7a64]"
            />
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={state === "listening" ? stopListening : startListening}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-[#1f7a64] px-4 font-medium text-white transition hover:bg-[#185f4e] disabled:cursor-not-allowed disabled:opacity-45"
                disabled={!speechSupported}
              >
                {state === "listening" ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                {state === "listening" ? "Stop" : "Mic"}
              </button>
              <button
                type="button"
                onClick={askZo}
                className="inline-flex h-11 items-center gap-2 rounded-md bg-[#141311] px-4 font-medium text-white transition hover:bg-black"
              >
                <Send className="h-4 w-4" />
                Ask Zo
              </button>
              <button
                type="button"
                onClick={() => setVoiceEnabled((enabled) => !enabled)}
                className="grid h-11 w-11 place-items-center rounded-md border border-[#141311]/15 bg-white transition hover:bg-[#fffaf0]"
                aria-label={voiceEnabled ? "Disable spoken response" : "Enable spoken response"}
                title={voiceEnabled ? "Disable spoken response" : "Enable spoken response"}
              >
                {voiceEnabled ? <Volume2 className="h-4 w-4" /> : <VolumeX className="h-4 w-4" />}
              </button>
              <button
                type="button"
                onClick={reset}
                className="grid h-11 w-11 place-items-center rounded-md border border-[#141311]/15 bg-white transition hover:bg-[#fffaf0]"
                aria-label="Reset"
                title="Reset"
              >
                <Eraser className="h-4 w-4" />
              </button>
            </div>
          </section>

          <section className="grid gap-4">
            <div className="rounded-lg border border-[#141311]/15 bg-[#141311] p-4 text-[#f6f1e7] shadow-sm">
              <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-[#c9c0af]">
                Local privacy pass
              </p>
              <p className="min-h-[96px] whitespace-pre-wrap text-base leading-7">
                {preparedPrompt || "Sensitive patterns are redacted locally before a prompt is sent to Zo."}
              </p>
            </div>

            <div className="min-h-[310px] rounded-lg border border-[#141311]/15 bg-white p-4 shadow-sm">
              <p className="mb-3 text-sm font-medium uppercase tracking-[0.18em] text-[#5f5a50]">
                Zo response
              </p>
              <div className="whitespace-pre-wrap text-lg leading-8">
                {response || "Zo's answer will stream here."}
              </div>
              {error ? (
                <div className="mt-4 rounded-md border border-[#b42318]/25 bg-[#fff4f2] p-3 text-sm text-[#b42318]">
                  {error}
                </div>
              ) : null}
            </div>
          </section>
        </div>
      </section>
    </main>
  );
}
