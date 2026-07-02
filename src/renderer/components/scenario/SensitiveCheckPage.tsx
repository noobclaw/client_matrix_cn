/**
 * SensitiveCheckPage — paste your XHS draft, get a list of risky words.
 *
 * Calls POST /api/sensitive/check (no auth needed). Renders:
 *   - Risk score banner (0-100, color-coded)
 *   - Original text with each match highlighted in-line
 *   - Per-category breakdown
 *   - Suggested rewrites: just hides the matched span, user can replace
 *
 * Library is admin-managed via the backend admin panel — this page only
 * consumes /check, it does not modify the dictionary.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { getBackendApiUrl } from '../../services/endpoints';

interface Match {
  word: string;
  category: string;
  severity: 'low' | 'medium' | 'high';
  start: number;
  end: number;
  matched_text: string;
  source?: string | null;
  note?: string | null;
}

interface CheckResult {
  total_matches: number;
  distinct_words: number;
  risk_score: number;
  highest_severity: 'low' | 'medium' | 'high' | null;
  matches: Match[];
  summary: Record<string, { count: number; severities: { low: number; medium: number; high: number } }>;
}

interface CategoryMeta { key: string; label: string; count: number }

const CATEGORY_LABELS_FALLBACK: Record<string, string> = {
  ad_absolute: '绝对化用语',
  ad_promo: '促销夸大',
  medical: '医疗医美',
  finance: '金融引流',
  contact: '站外引流',
  illegal: '违法违禁',
  politics: '政治敏感',
  privacy: '隐私挖人',
  spam: '引流话术',
  other: '其它',
};

const SEVERITY_COLOR: Record<string, string> = {
  low: '#9ca3af',
  medium: '#eab308',
  high: '#ef4444',
};
const SEVERITY_LABELS = (): Record<string, string> => ({ low: i18nService.t('scSevLow'), medium: i18nService.t('scSevMedium'), high: i18nService.t('scSevHigh') });

interface Props {
  onBack: () => void;
}

export const SensitiveCheckPage: React.FC<Props> = ({ onBack }) => {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<CheckResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [severityMin, setSeverityMin] = useState<'low' | 'medium' | 'high'>('low');
  const [categories, setCategories] = useState<CategoryMeta[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const sevLabel = SEVERITY_LABELS();

  // Pull category list once for the filter chips
  useEffect(() => {
    fetch(`${getBackendApiUrl()}/api/sensitive/categories`)
      .then(r => r.json())
      .then(d => setCategories(Array.isArray(d?.categories) ? d.categories : []))
      .catch(() => setCategories([]));
  }, []);

  const handleCheck = async () => {
    if (loading) return;
    if (!text.trim()) {
      setErr(i18nService.t('scPasteTextToCheck'));
      return;
    }
    setErr(null);
    setLoading(true);
    setResult(null);
    try {
      const body: Record<string, unknown> = { text, severity_min: severityMin };
      if (activeCategory) body.categories = [activeCategory];
      const res = await fetch(`${getBackendApiUrl()}/api/sensitive/check`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setErr(data?.error || `HTTP ${res.status}`);
      } else {
        setResult(data);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  // Build the highlighted text. We walk the matches in start order and
  // splice in <mark> tags. Because matches can overlap (e.g. "全网最低"
  // contains "最低"), we resolve by keeping the longest one at each start.
  const highlighted = useMemo(() => {
    if (!result || !text) return null;
    const matches = [...result.matches].sort((a, b) =>
      a.start - b.start || (b.end - b.start) - (a.end - a.start)
    );
    // Drop any match fully contained inside an earlier longer one
    const kept: Match[] = [];
    for (const m of matches) {
      const last = kept[kept.length - 1];
      if (last && m.start < last.end) continue;
      kept.push(m);
    }

    const nodes: React.ReactNode[] = [];
    let cursor = 0;
    kept.forEach((m, i) => {
      if (m.start > cursor) nodes.push(<span key={`t-${i}`}>{text.slice(cursor, m.start)}</span>);
      const color = SEVERITY_COLOR[m.severity] || '#888';
      nodes.push(
        <mark
          key={`m-${i}`}
          title={`${m.word} · ${CATEGORY_LABELS_FALLBACK[m.category] || m.category} · ${sevLabel[m.severity]}`}
          style={{
            background: color + '33',
            color,
            padding: '0 2px',
            borderRadius: 3,
            borderBottom: `2px solid ${color}`,
            fontWeight: 600,
          }}
        >
          {text.slice(m.start, m.end)}
        </mark>
      );
      cursor = m.end;
    });
    if (cursor < text.length) nodes.push(<span key="tail">{text.slice(cursor)}</span>);
    return nodes;
  }, [result, text, sevLabel]);

  const riskColor = (s: number): string => {
    if (s >= 70) return '#ef4444';
    if (s >= 40) return '#f59e0b';
    if (s >= 15) return '#eab308';
    return '#22c55e';
  };
  const riskLabel = (s: number): string => {
    if (s >= 70) return i18nService.t('scRiskHigh');
    if (s >= 40) return i18nService.t('scRiskMedium');
    if (s >= 15) return i18nService.t('scRiskLow');
    return i18nService.t('scRiskSafe');
  };

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const charCount = text.length;
  const charLimit = 5000;

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button
          type="button"
          onClick={onBack}
          className="px-3 py-1.5 text-sm rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
        >
          ← {i18nService.t('scBack')}
        </button>
        <h1 className="text-xl font-bold dark:text-white">
          🚫 {i18nService.t('scTitle')}
        </h1>
      </div>

      {/* Description */}
      <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 leading-relaxed">
        {i18nService.t('scDescription')}
      </p>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-3">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {i18nService.t('scMinSeverity')}:
        </span>
        {(['low', 'medium', 'high'] as const).map(s => (
          <button
            key={s}
            type="button"
            onClick={() => setSeverityMin(s)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              severityMin === s
                ? 'bg-green-500/10 border-green-500/50 text-green-500'
                : 'border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
          >
            {sevLabel[s]}
          </button>
        ))}
        <span className="w-px h-4 bg-gray-300 dark:bg-gray-700 mx-2" />
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {i18nService.t('scCategory')}:
        </span>
        <button
          type="button"
          onClick={() => setActiveCategory('')}
          className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
            activeCategory === ''
              ? 'bg-green-500/10 border-green-500/50 text-green-500'
              : 'border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
          }`}
        >
          {i18nService.t('scAll')}
        </button>
        {categories.map(c => (
          <button
            key={c.key}
            type="button"
            onClick={() => setActiveCategory(c.key)}
            className={`px-2.5 py-1 text-xs rounded-full border transition-colors ${
              activeCategory === c.key
                ? 'bg-green-500/10 border-green-500/50 text-green-500'
                : 'border-gray-300 dark:border-gray-700 text-gray-500 hover:bg-gray-100 dark:hover:bg-gray-800'
            }`}
            title={`${c.count} ${i18nService.t('scWordsUnit')}`}
          >
            {c.label}
          </button>
        ))}
      </div>

      {/* Input + button */}
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
        <textarea
          ref={textareaRef}
          value={text}
          maxLength={charLimit}
          onChange={(e) => setText(e.target.value)}
          placeholder={i18nService.t('scPlaceholder')}
          rows={10}
          className="w-full px-4 py-3 text-sm bg-transparent text-gray-900 dark:text-white outline-none resize-y min-h-[180px] leading-relaxed"
        />
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-gray-100 dark:border-gray-800 bg-gray-50 dark:bg-gray-800/50">
          <span className="text-[11px] text-gray-500 dark:text-gray-400">
            {charCount} / {charLimit}
          </span>
          <div className="flex gap-2">
            <button
              type="button"
              disabled={loading}
              onClick={() => { setText(''); setResult(null); setErr(null); }}
              className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50"
            >
              {i18nService.t('scClear')}
            </button>
            <button
              type="button"
              disabled={loading}
              onClick={handleCheck}
              className="px-4 py-1.5 text-xs font-semibold rounded-lg bg-green-500 text-white hover:bg-green-600 active:scale-95 disabled:opacity-50"
            >
              {loading ? i18nService.t('scChecking') : i18nService.t('scCheck')}
            </button>
          </div>
        </div>
      </div>

      {err && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30 text-sm text-red-500">
          {err}
        </div>
      )}

      {/* Result */}
      {result && (
        <div className="mt-6 space-y-4">
          {/* Risk banner */}
          <div
            className="rounded-xl p-4 border"
            style={{
              background: riskColor(result.risk_score) + '15',
              borderColor: riskColor(result.risk_score) + '50',
            }}
          >
            <div className="flex items-center gap-4 flex-wrap">
              <div
                className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold"
                style={{
                  background: riskColor(result.risk_score) + '30',
                  color: riskColor(result.risk_score),
                }}
              >
                {result.risk_score}
              </div>
              <div className="flex-1 min-w-[200px]">
                <div className="text-base font-semibold mb-1" style={{ color: riskColor(result.risk_score) }}>
                  {riskLabel(result.risk_score)}
                </div>
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  {i18nService.t('scHitsSummary').replace('{hits}', String(result.total_matches)).replace('{words}', String(result.distinct_words))}
                </div>
              </div>
            </div>
          </div>

          {/* Highlighted text */}
          {result.matches.length > 0 ? (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4">
              <div className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400 mb-2">
                {i18nService.t('scAnnotatedText')}
              </div>
              <div className="text-sm text-gray-900 dark:text-white whitespace-pre-wrap leading-relaxed break-words">
                {highlighted}
              </div>
            </div>
          ) : (
            <div className="rounded-xl border border-green-500/30 bg-green-500/5 p-6 text-center text-sm text-green-500">
              ✅ {i18nService.t('scNoSensitiveWords')}
            </div>
          )}

          {/* Per-category summary */}
          {result.matches.length > 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {i18nService.t('scCategorySummary')}
              </div>
              <table className="w-full text-sm">
                <thead className="text-xs text-gray-500 dark:text-gray-400 bg-gray-50 dark:bg-gray-800/30">
                  <tr>
                    <th className="text-left px-4 py-2 font-medium">{i18nService.t('scCategory')}</th>
                    <th className="text-right px-4 py-2 font-medium">{i18nService.t('scColHigh')}</th>
                    <th className="text-right px-4 py-2 font-medium">{i18nService.t('scColMed')}</th>
                    <th className="text-right px-4 py-2 font-medium">{i18nService.t('scColLow')}</th>
                    <th className="text-right px-4 py-2 font-medium">{i18nService.t('scColTotal')}</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(result.summary)
                    .sort((a, b) => b[1].count - a[1].count)
                    .map(([cat, info]) => (
                      <tr key={cat} className="border-t border-gray-100 dark:border-gray-800">
                        <td className="px-4 py-2 dark:text-white">{CATEGORY_LABELS_FALLBACK[cat] || cat}</td>
                        <td className="px-4 py-2 text-right text-red-500">{info.severities.high || ''}</td>
                        <td className="px-4 py-2 text-right text-yellow-500">{info.severities.medium || ''}</td>
                        <td className="px-4 py-2 text-right text-gray-500">{info.severities.low || ''}</td>
                        <td className="px-4 py-2 text-right font-semibold dark:text-white">{info.count}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Detailed match list */}
          {result.matches.length > 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 overflow-hidden">
              <div className="px-4 py-2.5 border-b border-gray-100 dark:border-gray-800 text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
                {i18nService.t('scMatchDetail')}
              </div>
              <div className="max-h-96 overflow-y-auto">
                {result.matches.map((m, i) => (
                  <div
                    key={i}
                    className="flex items-center gap-3 px-4 py-2.5 border-t border-gray-100 dark:border-gray-800 first:border-t-0 text-sm"
                  >
                    <span
                      className="px-2 py-0.5 rounded text-xs font-semibold shrink-0"
                      style={{
                        background: SEVERITY_COLOR[m.severity] + '22',
                        color: SEVERITY_COLOR[m.severity],
                      }}
                    >
                      {sevLabel[m.severity]}
                    </span>
                    <span className="font-mono font-semibold dark:text-white shrink-0 min-w-[80px]">
                      {m.word}
                    </span>
                    <span className="text-xs text-gray-500 dark:text-gray-400 shrink-0">
                      {CATEGORY_LABELS_FALLBACK[m.category] || m.category}
                    </span>
                    <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
                      {i18nService.t('scPosition')} {m.start}
                    </span>
                    {m.note && (
                      <span className="text-[11px] text-gray-400 dark:text-gray-500 italic max-w-[200px] truncate" title={m.note}>
                        {m.note}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default SensitiveCheckPage;
