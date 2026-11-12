/**
 * What each waiting agent of the inbox asks (components/AgentInbox.tsx): its prompt card read once per
 * wait through the read-only GET /api/pane/prompt, a few at a time. Nothing is answered from here.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { InteractivePrompt } from "../../shared/protocol.ts";
import { inboxKey, inboxStatus, questionWords } from "./agentInbox.ts";
import { agentGroup, type AgentRow } from "./agentRoster.ts";
import { fetchPanePromptState } from "./api.ts";
import { t } from "./i18n.ts";
import { promptWords } from "./promptText.ts";
import type { SidebarActivity } from "./sidebarActivity.tsx";

/** How long after an empty answer the card is asked for once more: the state push can precede the drawn card. */
export const QUESTION_RETRY_MS = 1500;
/** Prompt reads in flight at once, so a list of waiting agents never fans out. */
export const QUESTION_READS_AT_ONCE = 2;

/** A waiting row whose question is read: `seq` is its state counter, a new wait reads it again. */
export interface QuestionTarget { key: string; machineId: string; paneId: string; seq: number }

/** The rows of a PC in reach that wait for the user and whose agent reported no words of its own. */
export function questionTargets(rows: readonly AgentRow[], activity: SidebarActivity): QuestionTarget[] {
  return rows.flatMap((row) => {
    const pane = row.entry.pane;
    if (agentGroup(inboxStatus(row, activity)) !== "blocked" || pane.agent_kind || pane.agent_message?.trim()) return [];
    return [{ key: inboxKey(row), machineId: row.machine.id, paneId: pane.pane_id, seq: activity.seqs(row.machine.id).get(pane.pane_id) ?? 0 }];
  });
}

type Read = (paneId: string, machineId: string) => Promise<{ prompt: InteractivePrompt | null }>;
type Wait = (run: () => void, ms: number) => () => void;

const NO_TEXTS: ReadonlyMap<string, string> = new Map();
const readOf = (target: QuestionTarget): string => `${target.key}\n${target.seq}`;

/**
 * Each target's question, read once per key and seq, at most QUESTION_READS_AT_ONCE at a time. An empty
 * answer is asked once more after QUESTION_RETRY_MS; a failed read waits for the next seq. An answer for
 * a target gone or moved on since, or after `stop()`, is dropped.
 */
export class QuestionReads {
  private readonly listeners = new Set<() => void>();
  private current: ReadonlyMap<string, string> = NO_TEXTS;
  private targets = new Map<string, QuestionTarget>();
  /** the key-and-seq reads started or queued, and those already given their one retry */
  private readonly started = new Set<string>();
  private readonly retried = new Set<string>();
  private readonly waits = new Map<string, () => void>();
  private queue: QuestionTarget[] = [];
  private inFlight = 0;
  private stopped = false;

  constructor(private readonly read: Read, private readonly words: (prompt: InteractivePrompt) => string,
    private readonly wait: Wait = (run, ms) => { const timer = setTimeout(run, ms); return () => clearTimeout(timer); }) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  };

  /** The same object until a text is added, replaced or removed. */
  texts = (): ReadonlyMap<string, string> => this.current;

  sync(targets: readonly QuestionTarget[]): void {
    if (this.stopped) return;
    this.targets = new Map(targets.map((target) => [target.key, target]));
    const live = new Set(targets.map(readOf));
    for (const read of [...this.started]) {
      if (live.has(read)) continue;
      this.started.delete(read);
      this.retried.delete(read);
      this.waits.get(read)?.();
      this.waits.delete(read);
    }
    this.queue = this.queue.filter((target) => this.isCurrent(target));
    const gone = [...this.current.keys()].filter((key) => !this.targets.has(key));
    if (gone.length > 0) this.change((texts) => { for (const key of gone) texts.delete(key); });
    for (const target of targets) {
      const read = readOf(target);
      if (this.started.has(read)) continue;
      this.started.add(read);
      this.queue.push(target);
    }
    this.pump();
  }

  stop(): void {
    this.stopped = true;
    for (const cancel of this.waits.values()) cancel();
    this.waits.clear();
    this.queue = [];
  }

  private isCurrent(target: QuestionTarget): boolean {
    return !this.stopped && this.targets.get(target.key)?.seq === target.seq;
  }

  private change(edit: (texts: Map<string, string>) => void): void {
    const next = new Map(this.current);
    edit(next);
    this.current = next;
    for (const listener of [...this.listeners]) listener();
  }

  private pump(): void {
    while (!this.stopped && this.inFlight < QUESTION_READS_AT_ONCE && this.queue.length > 0) {
      const target = this.queue.shift()!;
      if (this.isCurrent(target)) this.start(target);
    }
  }

  private start(target: QuestionTarget): void {
    this.inFlight++;
    const settle = () => { this.inFlight--; this.pump(); };
    this.read(target.paneId, target.machineId).then(({ prompt }) => {
      settle();
      if (!this.isCurrent(target)) return;
      if (prompt !== null) {
        const words = this.words(prompt);
        if (this.current.get(target.key) !== words) this.change((texts) => { texts.set(target.key, words); });
        return;
      }
      const read = readOf(target);
      if (this.retried.has(read)) return;
      this.retried.add(read);
      this.waits.set(read, this.wait(() => {
        this.waits.delete(read);
        if (!this.isCurrent(target)) return;
        this.queue.push(target);
        this.pump();
      }, QUESTION_RETRY_MS));
    }, settle);
  }
}

const newReads = (): QuestionReads => new QuestionReads(fetchPanePromptState, (prompt) => questionWords(promptWords(prompt, t)));
const noSubscribe = (): (() => void) => () => {};
const noTexts = (): ReadonlyMap<string, string> => NO_TEXTS;

/** Each waiting target's question by its key, read while the caller is mounted. */
export function useInboxQuestions(targets: readonly QuestionTarget[]): ReadonlyMap<string, string> {
  // made in an effect, so StrictMode's second mount gets a reader its first cleanup did not stop
  const [reads, setReads] = useState<QuestionReads | null>(null);
  const targetsRef = useRef(targets); targetsRef.current = targets;
  const signature = targets.map((target) => `${target.key}:${target.seq}`).join("\n");
  useEffect(() => {
    const next = newReads();
    setReads(next);
    return () => next.stop();
  }, []);
  useEffect(() => { reads?.sync(targetsRef.current); }, [reads, signature]);
  return useSyncExternalStore(reads?.subscribe ?? noSubscribe, reads?.texts ?? noTexts, reads?.texts ?? noTexts);
}
