import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const appSource = await readFile(new URL('./App.tsx', import.meta.url), 'utf8');
const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8');
const artifactViewerSource = await readFile(new URL('./components/ArtifactViewer.tsx', import.meta.url), 'utf8');
const preloadSource = await readFile(new URL('../electron/preload.cjs', import.meta.url), 'utf8');
const electronMainSource = await readFile(new URL('../electron/main.mjs', import.meta.url), 'utf8');

test('the island presents one intervention instead of a notification inbox', () => {
  for (const removed of [
    'IslandTab',
    'suggestionIndex',
    'moveSuggestion',
    'island-tabs',
    'island-composer',
    'itemKeyRef',
    'runtimeKeyRef',
  ]) {
    assert.equal(appSource.includes(removed), false, `${removed} should stay removed`);
  }
  assert.match(appSource, /selectSurfaceItem\(snapshot\)/u);
  assert.equal(appSource.includes('if (resolved.length === 3) break'), false);
  assert.match(appSource, /'snooze',[\s\S]*?'dismiss'/u);
  assert.match(appSource, /return `老大，\$\{title \|\| fallback\}`/u);
});

test('artifact results stay inside the island and feedback lives in the overflow menu', () => {
  assert.match(appSource, /<ArtifactViewer/u);
  assert.match(appSource, /<DocumentLinks/u);
  assert.match(appSource, /不重要/u);
  assert.match(appSource, /已过期/u);
  assert.match(appSource, /稍后再看/u);
  assert.match(appSource, /为什么推给我/u);
  assert.match(appSource, /kind: 'suggestion_expanded'/u);
  assert.match(appSource, /setArtifactView\(\{ item: target, openedDeliveryId: targetId \}\)/u);
  assert.match(appSource, /onBack=\{\(\) => setArtifactView\(null\)\}/u);
  assert.match(appSource, /<ArtifactViewer[\s\S]*?readOnly/u);
  assert.match(artifactViewerSource, /!readOnly \|\| action\.intent === 'view_artifact'/u);
  assert.match(appSource, /item=\{historyArtifact\.opportunity\}\s+readOnly/u);
  assert.match(appSource, /item=\{artifactView\.item\.opportunity\}\s+openedDeliveryId=\{artifactView\.openedDeliveryId\}\s+pendingActions/u);
  assert.equal(appSource.includes("act('viewed', '已读并收起')"), false);
  assert.match(artifactViewerSource, /action\.targetId !== openedDeliveryId/u);
  assert.match(artifactViewerSource, /readOnly \? actions\.slice\(0, 1\) : actions/u);
  assert.match(artifactViewerSource, /hasStructuredSections && !showSource/u);
});

test('consumed suggestions leave the main surface and remain available in compact history', () => {
  assert.match(appSource, /function HistoryPanel/u);
  assert.match(appSource, /<HistoryPanel items=\{history\}/u);
  assert.match(appSource, /历史记录/u);
  assert.match(appSource, /actOnOpportunity\(target\.actionId, learningAction\)/u);
  assert.match(appSource, /intent === 'continue_codex' \|\| intent === 'ask'/u);
  assert.match(appSource, /actOnOpportunity\(target\.actionId, 'viewed'\)/u);
  assert.match(appSource, /await act\(target, 'snooze', '已移到历史，可稍后查看'\)/u);
  assert.match(appSource, /VIEWED_DWELL_MS = 4_000/u);
  assert.match(appSource, /session\.activation === 'click'/u);
  assert.match(appSource, /session\.kind !== 'work_progress'/u);
  assert.match(appSource, /const target = artifactView \|\| historyArtifact \? 'codex' : item \? 'suggestion' : 'empty'/u);
  assert.match(appSource, /onPointerDown=\{markDeliberateView\}/u);
  assert.match(appSource, /state\.mode === 'dormant' && modeRef\.current !== 'dormant'/u);
  assert.match(appSource, /setHistoryArtifact\(null\)/u);
});

test('packaged history artifacts are normalized through the trusted loopback API', async () => {
  const apiSource = await readFile(new URL('./api.ts', import.meta.url), 'utf8');
  assert.match(apiSource, /history: \(snapshot\.history \?\? \[\]\)\.map/u);
  assert.match(apiSource, /artifactUrl: normalizeArtifactUrl\(entry\.opportunity\.artifactUrl\)/u);
});

test('verified deliveries remain host-derived while model actions are not quantity-capped', () => {
  assert.match(appSource, /function deliveryAction\(deliveries: DeliveryReference\[\]\)/u);
  assert.match(appSource, /intent: 'open_delivery'/u);
  assert.match(appSource, /desktop\.openDelivery\(targetId\)/u);
  assert.match(appSource, /result\.presentation === 'in_app'/u);
  assert.match(appSource, /\.\.\.\(hostAction \? \[hostAction\] : \[\]\)/u);
  assert.match(appSource, /if \(hostAction && action\.intent === 'view_artifact'\) continue/u);
  assert.equal(appSource.includes('if (resolved.length === 3) break'), false);
  assert.match(appSource, /expandedHeightForActions/u);
  assert.match(appSource, /desktop\.setContentHeight\(height\)/u);
  assert.match(preloadSource, /window:set-content-height/u);
  assert.match(electronMainSource, /setIslandContentHeight/u);
  assert.match(appSource, /data-count=\{item\.actions\.length\}/u);
  assert.match(artifactViewerSource, /data-count=\{availableActions\.length\}/u);
  assert.equal(styles.includes('button:nth-child(n + 3)'), false);
});

test('the renderer cannot revive Silence Gate rejects through legacy or job-history fallbacks', () => {
  assert.match(appSource, /if \(Array\.isArray\(snapshot\.interventions\)\)/u);
  assert.match(appSource, /return intervention \? fromIntervention\(intervention\) : null/u);
  assert.match(appSource, /HIDDEN_INTERVENTION_STATES = new Set\(\['snoozed', 'dismissed', 'completed'\]\)/u);
  assert.equal(appSource.includes("['running', 'complete', 'error'].includes(current.state)"), false);
  assert.equal(appSource.includes('itemKeyRef'), false);
  assert.equal(appSource.includes('runtimeKeyRef'), false);
});

test('motion expands downward while every island mode keeps a true capsule silhouette', () => {
  assert.match(appSource, /LEAVE_COLLAPSE_MS = 800/u);
  assert.match(appSource, /COLLAPSE_ANIMATION_MS = 180/u);
  assert.match(appSource, /isCollapsing \? 'is-closing' : ''/u);
  assert.match(styles, /\.island-stage\.mode-dormant\s*\{[\s\S]*?background:\s*transparent/u);
  assert.match(styles, /\.dormant-notch\s*\{[\s\S]*?border-radius:\s*var\(--radius-capsule\)/u);
  assert.match(styles, /\.glance-island,\s*\.expanded-island\s*\{[\s\S]*?border-radius:\s*var\(--radius-panel\)/u);
  assert.equal(styles.includes('border-radius: 0 0 var(--radius-panel)'), false);
  assert.equal(electronMainSource.includes("vibrancy: 'hud'"), false);
  assert.match(styles, /--motion-island:\s*400ms/u);
  assert.match(styles, /animation:\s*island-expand var\(--motion-island\) var\(--ease-apple-out\)/u);
  assert.match(styles, /from \{ opacity: 0\.7; transform: translateY\(-10px\); \}/u);
  assert.match(styles, /@keyframes island-close/u);
  assert.equal(styles.includes('scaleY('), false);
  assert.equal(styles.includes('clip-path: inset(0 0 92%'), false);
  assert.match(styles, /prefers-reduced-motion:\s*reduce/u);
  assert.match(styles, /prefers-reduced-transparency:\s*reduce/u);
  assert.match(styles, /backdrop-filter:\s*blur\(26px\)/u);
  assert.match(styles, /\.object-actions > :first-child\s*\{\s*grid-column: 1 \/ -1/u);
  assert.match(styles, /\.artifact-native-actions > :first-child\s*\{\s*grid-column: 1 \/ -1/u);
  assert.match(styles, /transform:\s*scaleX\(var\(--progress/u);
});
