// The pruned transcript and the recorded facts, built together so the summary
// prompt and the summary evidence can never disagree about the same messages.
import {
  extractEvidence,
  pruneMessages,
  renderTranscript,
  type CompactEvidence,
  type DigestOptions,
  type PrunedTurn,
} from "./compact-digest";

export interface CompactionDigest {
  transcript: string;
  turns: PrunedTurn[];
  evidence: CompactEvidence;
  stats: CompactEvidence["stats"] & { transcriptChars: number };
}

export function digestMessagesForCompaction(messages: unknown[], cwd?: string, options?: DigestOptions): CompactionDigest {
  const turns = pruneMessages(messages, options);
  const evidence = extractEvidence(messages, cwd);
  const transcript = renderTranscript(turns);
  return {
    transcript,
    turns,
    evidence,
    stats: { ...evidence.stats, transcriptChars: transcript.length },
  };
}
