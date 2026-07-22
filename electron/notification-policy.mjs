function candidateKey(item = {}) {
  return [item.id, item.kind, item.state, item.updatedAt || item.completedAt || ''].join(':');
}

function isEligible(item = {}) {
  if (item.kind === 'work_result' && item.state === 'ready') return true;
  if (item.kind === 'decision' && ['waiting', 'error'].includes(item.state) && item.priority === 'high') return true;
  return item.kind === 'recommendation'
    && item.state === 'active'
    && item.priority === 'high'
    && item.interruption === 'notify';
}

export function notificationKeysForSnapshot(snapshot = {}) {
  return (snapshot.interventions || []).filter(isEligible).map(candidateKey);
}

export function selectNotificationCandidate(snapshot = {}, notifiedKeys = new Set()) {
  if (['meeting', 'focus', 'stale'].includes(snapshot.now?.state)) return null;
  const weight = { work_result: 3, decision: 2, recommendation: 1 };
  return (snapshot.interventions || [])
    .filter(isEligible)
    .filter((item) => !notifiedKeys.has(candidateKey(item)))
    .sort((left, right) => (
      (weight[right.kind] || 0) - (weight[left.kind] || 0)
      || String(right.updatedAt || right.completedAt || '').localeCompare(String(left.updatedAt || left.completedAt || ''))
    ))
    .map((item) => ({ item, key: candidateKey(item) }))[0] || null;
}
