import type { Opportunity } from './types';

export type GroupTone = 'ready' | 'running' | 'active' | 'quiet';

export interface OpportunityGroup {
  key: string;
  label: string;
  items: Opportunity[];
  latest: Opportunity;
  status: {
    label: string;
    tone: GroupTone;
  };
}

function cleanGroupValue(value: string | undefined): string | null {
  const clean = value?.trim();
  return clean ? clean : null;
}

function groupStatus(items: Opportunity[]): OpportunityGroup['status'] {
  if (items.some((item) => item.status === 'ready')) {
    return { label: '产物已就绪', tone: 'ready' };
  }
  if (items.some((item) => item.status === 'preparing')) {
    return { label: 'Codex 执行中', tone: 'running' };
  }
  if (items.some((item) => item.status === 'active')) {
    return { label: '待查看', tone: 'active' };
  }
  return { label: '已收起', tone: 'quiet' };
}

export function groupOpportunities(items: Opportunity[]): OpportunityGroup[] {
  const groups = new Map<string, { key: string; label: string; items: Opportunity[] }>();

  for (const item of items) {
    const providedKey = cleanGroupValue(item.groupKey);
    const providedLabel = cleanGroupValue(item.groupLabel);
    // Without an explicit grouping signal, one item becomes one group. This is
    // intentionally conservative: unrelated suggestions must never be merged
    // just because their source or category happens to match.
    const key = providedKey || (providedLabel ? `label:${providedLabel}` : `item:${item.id}`);
    const existing = groups.get(key);
    if (existing) {
      existing.items.push(item);
      continue;
    }
    groups.set(key, {
      key,
      label: providedLabel || item.title,
      items: [item],
    });
  }

  return [...groups.values()].map((group) => ({
    ...group,
    // The engine orders opportunities by current relevance, so the first row
    // is also the safest summary when no explicit item timestamp is available.
    latest: group.items[0],
    status: groupStatus(group.items),
  }));
}
