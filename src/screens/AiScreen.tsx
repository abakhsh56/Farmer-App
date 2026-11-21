import { useState } from 'react';
import { AgentScreen } from './AgentScreen';
import { ScanScreen } from './ScanScreen';

/**
 * The second tab: photo diagnosis and the assistant, in one place.
 *
 * The PRD's navigation names this destination "Scan / AI", and it is one tab
 * rather than two on purpose — they are the same conversation with a different
 * opening question. A farmer photographing a leaf and a farmer typing "my cotton
 * has yellow leaves" are asking for the same help, and the diagnosis screen
 * already continues as a thread.
 *
 * Scan is the landing step, because it is the reason most farmers open the tab
 * and because it is the flow the locked design shows first. The assistant is one
 * deliberate tap away, and it is also where a scan's follow-up questions end up.
 *
 * The mode is local state: which half of the tab the farmer is looking at is
 * where they are standing, not something to restore three days later.
 */
export function AiScreen({ onOpenDealers }: { onOpenDealers: () => void }) {
  const [mode, setMode] = useState<'scan' | 'agent'>('scan');

  if (mode === 'agent') {
    return (
      <AgentScreen onOpenDealers={onOpenDealers} onOpenScan={() => setMode('scan')} />
    );
  }

  return (
    <ScanScreen onOpenDealers={onOpenDealers} onOpenAgent={() => setMode('agent')} />
  );
}
