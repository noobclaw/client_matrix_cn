import React, { useState, useRef, useEffect, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { scheduledTaskService } from '../../services/scheduledTask';
import { i18nService } from '../../services/i18n';
import { imService } from '../../services/im';
import { getNotifyIMPlatforms } from '../../utils/regionFilter';
import type { ScheduledTask, Schedule, ScheduledTaskInput, NotifyPlatform } from '../../types/scheduledTask';

interface TaskFormProps {
  mode: 'create' | 'edit';
  task?: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
}

type ScheduleMode = 'once' | 'daily' | 'weekly' | 'monthly';

const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const; // 0=Sunday

// Parse existing schedule into UI state
function parseScheduleToUI(schedule: Schedule): {
  mode: ScheduleMode;
  date: string;
  time: string;
  weekday: number;
  monthDay: number;
} {
  const defaults = { mode: 'once' as ScheduleMode, date: '', time: '09:00', weekday: 1, monthDay: 1 };

  if (schedule.type === 'at') {
    const dt = schedule.datetime ?? '';
    // datetime-local format: "YYYY-MM-DDTHH:MM"
    if (dt.includes('T')) {
      return { ...defaults, mode: 'once', date: dt.slice(0, 10), time: dt.slice(11, 16) };
    }
    return { ...defaults, mode: 'once', date: dt.slice(0, 10) };
  }

  if (schedule.type === 'cron' && schedule.expression) {
    const parts = schedule.expression.trim().split(/\s+/);
    if (parts.length >= 5) {
      const [min, hour, dom, , dow] = parts;
      const timeStr = `${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;

      if (dow !== '*' && dom === '*') {
        // Weekly: M H * * DOW
        return { ...defaults, mode: 'weekly', time: timeStr, weekday: parseInt(dow) || 0 };
      }
      if (dom !== '*' && dow === '*') {
        // Monthly: M H DOM * *
        return { ...defaults, mode: 'monthly', time: timeStr, monthDay: parseInt(dom) || 1 };
      }
      // Daily: M H * * *
      return { ...defaults, mode: 'daily', time: timeStr };
    }
  }

  // Fallback for interval type - treat as daily
  if (schedule.type === 'interval') {
    return { ...defaults, mode: 'daily' };
  }

  return defaults;
}

const TaskForm: React.FC<TaskFormProps> = ({ mode, task, onCancel, onSaved }) => {
  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const imConfig = useSelector((state: RootState) => state.im.config);
  const defaultWorkingDirectory = coworkConfig?.workingDirectory ?? '';

  // Language tracking for region-based platform filtering
  const [, setLanguage] = useState<string>(i18nService.getLanguage());

  const visiblePlatforms = useMemo<NotifyPlatform[]>(() => {
    return getNotifyIMPlatforms() as unknown as NotifyPlatform[];
  }, []);

  // Parse existing schedule for edit mode
  const parsed = task ? parseScheduleToUI(task.schedule) : null;

  // For NEW tasks we deliberately leave scheduleDate/scheduleTime empty
  // so both macOS and Windows behave identically: user must actively
  // pick both fields. We tried auto-filling with `now + 1h` earlier,
  // but on macOS Chrome the rendered `type="date"` input displayed the
  // auto-filled value but the native date picker still required the
  // user to re-select it once — a confusing extra click. Leaving both
  // empty keeps platform parity and matches Windows's pre-existing
  // behavior. The split validation error messages below make the
  // "date required" vs "must be in future" case clear.
  //
  // Form state
  const [name, setName] = useState(task?.name ?? '');
  const [scheduleMode, setScheduleMode] = useState<ScheduleMode>(parsed?.mode ?? 'once');
  const [scheduleDate, setScheduleDate] = useState(parsed?.date ?? '');
  const [scheduleTime, setScheduleTime] = useState(parsed?.time ?? '');
  const [weekday, setWeekday] = useState(parsed?.weekday ?? 1);
  const [monthDay, setMonthDay] = useState(parsed?.monthDay ?? 1);
  const [prompt, setPrompt] = useState(task?.prompt ?? '');
  const [workingDirectory, setWorkingDirectory] = useState(task?.workingDirectory ?? '');
  const [expiresAt, setExpiresAt] = useState(task?.expiresAt ?? '');
  const [notifyPlatforms, setNotifyPlatforms] = useState<NotifyPlatform[]>(task?.notifyPlatforms ?? []);
  const [notifyDropdownOpen, setNotifyDropdownOpen] = useState(false);
  const notifyDropdownRef = useRef<HTMLDivElement>(null);
  const [submitting, setSubmitting] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (notifyDropdownRef.current && !notifyDropdownRef.current.contains(e.target as Node)) {
        setNotifyDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Subscribe to language changes
  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Load IM config on mount
  useEffect(() => {
    void imService.init();
  }, []);

  // Clean up selected platforms when visible list changes
  useEffect(() => {
    setNotifyPlatforms(prev => prev.filter(p => visiblePlatforms.includes(p)));
  }, [visiblePlatforms]);

  const isPlatformConfigured = (platform: NotifyPlatform): boolean => {
    // 'lark' maps to feishu gateway with domain='lark'
    if (platform === 'lark') {
      return !!(imConfig.feishu?.enabled && imConfig.feishu?.domain === 'lark');
    }
    const platformConfig = (imConfig as any)[platform];
    return platformConfig?.enabled ?? false;
  };

  const buildSchedule = (): Schedule => {
    const [hour, min] = scheduleTime.split(':').map(Number);
    switch (scheduleMode) {
      case 'once':
        return { type: 'at', datetime: `${scheduleDate}T${scheduleTime}` };
      case 'daily':
        return { type: 'cron', expression: `${min} ${hour} * * *` };
      case 'weekly':
        return { type: 'cron', expression: `${min} ${hour} * * ${weekday}` };
      case 'monthly':
        return { type: 'cron', expression: `${min} ${hour} ${monthDay} * *` };
    }
  };

  const validate = (): boolean => {
    const newErrors: Record<string, string> = {};
    if (!name.trim()) newErrors.name = i18nService.t('scheduledTasksFormValidationNameRequired');
    if (!prompt.trim()) newErrors.prompt = i18nService.t('scheduledTasksFormValidationPromptRequired');
    if (!(workingDirectory.trim() || defaultWorkingDirectory.trim())) {
      newErrors.workingDirectory = i18nService.t('scheduledTasksFormValidationWorkingDirectoryRequired');
    }
    // Schedule validation — branch by mode so the error messages stay
    // accurate. Previously the "once" branch reported
    // "执行时间必须在未来" for BOTH a missing date and a past datetime,
    // which led to the "time is in the future but it still complains"
    // bug when scheduleDate was empty. Now:
    //   - missing date / time → a specific "required" error
    //   - past datetime → the "must be in future" error
    if (scheduleMode === 'once') {
      if (!scheduleDate) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationDateRequired');
      } else if (!scheduleTime) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
      } else {
        // Local-time comparison — `new Date("YYYY-MM-DDTHH:MM")` with
        // no trailing Z is parsed as local time per ECMAScript 2015+.
        // Small grace window (30s) so a user who picks "now" doesn't
        // race the clock on submit.
        const fireAt = new Date(`${scheduleDate}T${scheduleTime}`).getTime();
        if (Number.isNaN(fireAt)) {
          newErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
        } else if (fireAt <= Date.now() - 30_000) {
          newErrors.schedule = i18nService.t('scheduledTasksFormValidationDatetimeFuture');
        }
      }
    } else {
      // Recurring modes only need a time.
      if (!scheduleTime) {
        newErrors.schedule = i18nService.t('scheduledTasksFormValidationTimeRequired');
      }
    }
    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async () => {
    if (!validate()) return;
    setSubmitting(true);
    try {
      const input: ScheduledTaskInput = {
        name: name.trim(),
        description: '',
        schedule: buildSchedule(),
        prompt: prompt.trim(),
        workingDirectory: workingDirectory.trim() || defaultWorkingDirectory,
        systemPrompt: '',
        executionMode: task?.executionMode ?? 'auto',
        expiresAt: expiresAt || null,
        notifyPlatforms,
        enabled: task?.enabled ?? true,
      };
      if (mode === 'create') {
        await scheduledTaskService.createTask(input);
      } else if (task) {
        await scheduledTaskService.updateTaskById(task.id, input);
      }
      onSaved();
    } catch {
      // Error handled by service
    } finally {
      setSubmitting(false);
    }
  };

  const handleBrowseDirectory = async () => {
    try {
      const result = await window.electron?.dialog?.selectDirectory();
      if (result?.success && result.path) {
        setWorkingDirectory(result.path);
      }
    } catch {
      // ignore
    }
  };

  const weekdayKeys: Record<number, string> = {
    0: 'scheduledTasksFormWeekSun',
    1: 'scheduledTasksFormWeekMon',
    2: 'scheduledTasksFormWeekTue',
    3: 'scheduledTasksFormWeekWed',
    4: 'scheduledTasksFormWeekThu',
    5: 'scheduledTasksFormWeekFri',
    6: 'scheduledTasksFormWeekSat',
  };

  const inputClass = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white px-3 py-2 text-sm dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent/50';
  const labelClass = 'block text-sm font-medium dark:text-claude-darkText text-claude-text mb-1';
  const errorClass = 'text-xs text-red-500 mt-1';

  const scheduleModes: ScheduleMode[] = ['once', 'daily', 'weekly', 'monthly'];

  return (
    <div className="p-4 space-y-4 max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
        {mode === 'create' ? i18nService.t('scheduledTasksFormCreate') : i18nService.t('scheduledTasksFormUpdate')}
      </h2>

      {/* Name */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormName')}</label>
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          className={inputClass}
          placeholder={i18nService.t('scheduledTasksFormNamePlaceholder')}
        />
        {errors.name && <p className={errorClass}>{errors.name}</p>}
      </div>

      {/* Prompt */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksPrompt')}</label>
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          className={inputClass + ' h-28 resize-none'}
          placeholder={i18nService.t('scheduledTasksFormPromptPlaceholder')}
        />
        {errors.prompt && <p className={errorClass}>{errors.prompt}</p>}
      </div>

      {/* Schedule */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormScheduleType')}</label>
        <div className="grid grid-cols-3 gap-2">
          {/* Schedule Mode Dropdown */}
          <select
            value={scheduleMode}
            onChange={(e) => setScheduleMode(e.target.value as ScheduleMode)}
            className={inputClass}
          >
            {scheduleModes.map((m) => (
              <option key={m} value={m}>
                {i18nService.t(`scheduledTasksFormScheduleMode${m.charAt(0).toUpperCase() + m.slice(1)}`)}
              </option>
            ))}
          </select>

          {/* Second column: date/weekday/monthday or time (for daily).
              For the "once" date and the standalone "time" inputs we
              wrap in a relative div and overlay a placeholder when the
              value is empty. This is needed because macOS Chrome
              renders an empty <input type="date"> with today's date
              shown in the input's main text color (not a grayed-out
              placeholder), which looks like a real value and confuses
              users. The overlay is pointer-events:none so clicks pass
              through to the input and still open the native picker. */}
          {scheduleMode === 'once' ? (
            <div className="relative">
              <input
                type="date"
                value={scheduleDate}
                onChange={(e) => setScheduleDate(e.target.value)}
                onClick={(e) => (e.target as HTMLInputElement).showPicker()}
                className={`${inputClass} ${!scheduleDate ? '[&::-webkit-datetime-edit]:opacity-0' : ''}`}
                min={new Date().toISOString().slice(0, 10)}
              />
              {!scheduleDate && (
                <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-sm dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                  {i18nService.t('scheduledTasksFormSchedulePickDate')}
                </div>
              )}
            </div>
          ) : scheduleMode === 'weekly' ? (
            <select
              value={weekday}
              onChange={(e) => setWeekday(parseInt(e.target.value))}
              className={inputClass}
            >
              {WEEKDAYS.map((d) => (
                <option key={d} value={d}>
                  {i18nService.t(weekdayKeys[d])}
                </option>
              ))}
            </select>
          ) : scheduleMode === 'monthly' ? (
            <select
              value={monthDay}
              onChange={(e) => setMonthDay(parseInt(e.target.value))}
              className={inputClass}
            >
              {Array.from({ length: 31 }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d}{i18nService.t('scheduledTasksFormMonthDaySuffix')}
                </option>
              ))}
            </select>
          ) : (
            <div className="relative">
              <input
                type="time"
                value={scheduleTime}
                onChange={(e) => setScheduleTime(e.target.value)}
                onClick={(e) => (e.target as HTMLInputElement).showPicker()}
                className={`${inputClass} ${!scheduleTime ? '[&::-webkit-datetime-edit]:opacity-0' : ''}`}
              />
              {!scheduleTime && (
                <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-sm dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                  {i18nService.t('scheduledTasksFormSchedulePickTime')}
                </div>
              )}
            </div>
          )}

          {/* Third column: time picker (or empty for daily).
              Native <input type="time"> does NOT work in Tauri WebView —
              showPicker() is unsupported and the edit fields are
              unresponsive. Use hour + minute selects instead. */}
          {scheduleMode === 'daily' ? (
            <div />
          ) : (
            <div className="flex items-center gap-2">
              <select
                value={(scheduleTime || '').split(':')[0] || ''}
                onChange={(e) => {
                  const hh = e.target.value.padStart(2, '0');
                  const mm = (scheduleTime || '').split(':')[1] || '00';
                  setScheduleTime(e.target.value ? `${hh}:${mm}` : '');
                }}
                style={{ appearance: 'auto', WebkitAppearance: 'menulist' }}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">时</option>
                {Array.from({ length: 24 }, (_, i) => (
                  <option key={i} value={String(i).padStart(2, '0')}>{String(i).padStart(2, '0')}</option>
                ))}
              </select>
              <span className="dark:text-white font-mono">:</span>
              <select
                value={(scheduleTime || '').split(':')[1] || ''}
                onChange={(e) => {
                  const hh = (scheduleTime || '').split(':')[0] || '08';
                  const mm = e.target.value.padStart(2, '0');
                  setScheduleTime(`${hh}:${mm}`);
                }}
                style={{ appearance: 'auto', WebkitAppearance: 'menulist' }}
                className={`${inputClass} cursor-pointer`}
              >
                <option value="">分</option>
                {Array.from({ length: 60 }, (_, i) => i).map(m => (
                  <option key={m} value={String(m).padStart(2, '0')}>{String(m).padStart(2, '0')}</option>
                ))}
              </select>
            </div>
          )}
        </div>
        {errors.schedule && <p className={errorClass}>{errors.schedule}</p>}
      </div>

      {/* Working Directory */}
      <div>
        <label className={labelClass}>{i18nService.t('scheduledTasksFormWorkingDirectory')}</label>
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={workingDirectory}
            onChange={(e) => setWorkingDirectory(e.target.value)}
            className={inputClass + ' flex-1'}
            placeholder={defaultWorkingDirectory || i18nService.t('scheduledTasksFormWorkingDirectoryPlaceholder')}
          />
          <button
            type="button"
            onClick={handleBrowseDirectory}
            className="px-3 py-2 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            {i18nService.t('browse')}
          </button>
        </div>
      </div>
      {errors.workingDirectory && <p className={errorClass}>{errors.workingDirectory}</p>}

      {/* Expires At */}
      <div>
        <label className={labelClass}>
          {i18nService.t('scheduledTasksFormExpiresAt')}
          <span className="text-xs font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary ml-1">
            {i18nService.t('scheduledTasksFormOptional')}
          </span>
        </label>
        <div className="flex items-center gap-2">
          {/* Expires date picker — same overlay pattern as the
              schedule date above; hides the macOS Chrome auto-display
              when value is empty. Expires is optional so the field
              stays empty by default and the overlay is the only thing
              the user sees until they pick a date. */}
          <div className="relative flex-1">
            <input
              type="date"
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              onClick={(e) => (e.target as HTMLInputElement).showPicker()}
              className={`${inputClass} w-full ${!expiresAt ? '[&::-webkit-datetime-edit]:opacity-0' : ''}`}
              min={new Date().toISOString().slice(0, 10)}
            />
            {!expiresAt && (
              <div className="pointer-events-none absolute inset-0 flex items-center px-3 text-sm dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                {i18nService.t('scheduledTasksFormSchedulePickDate')}
              </div>
            )}
          </div>
          {expiresAt && (
            <button
              type="button"
              onClick={() => setExpiresAt('')}
              className="px-3 py-2 text-sm rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('scheduledTasksFormExpiresAtClear')}
            </button>
          )}
        </div>
      </div>

      {/* Notification */}
      <div>
        <label className={labelClass}>
          {i18nService.t('scheduledTasksFormNotify')}
          <span className="text-xs font-normal dark:text-claude-darkTextSecondary text-claude-textSecondary ml-1">
            {i18nService.t('scheduledTasksFormOptional')}
          </span>
        </label>
        <div className="relative" ref={notifyDropdownRef}>
          <button
            type="button"
            onClick={() => setNotifyDropdownOpen(!notifyDropdownOpen)}
            className={inputClass + ' flex items-center justify-between cursor-pointer text-left'}
          >
            <span className={notifyPlatforms.length === 0 ? 'dark:text-claude-darkTextSecondary text-claude-textSecondary' : ''}>
              {notifyPlatforms.length === 0
                ? i18nService.t('scheduledTasksFormNotifyNone')
                : notifyPlatforms.map((p) =>
                    i18nService.t(`scheduledTasksFormNotify${p.charAt(0).toUpperCase() + p.slice(1)}`)
                  ).join(', ')}
            </span>
            <svg className={`w-4 h-4 ml-2 transition-transform ${notifyDropdownOpen ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
          {notifyDropdownOpen && (
            <div className="absolute z-10 bottom-full mb-1 w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-white shadow-lg py-1">
              {visiblePlatforms.map((platform) => {
                const checked = notifyPlatforms.includes(platform);
                const configured = isPlatformConfigured(platform);
                return (
                  <label
                    key={platform}
                    className={`flex items-center gap-2 px-3 py-2 transition-colors ${
                      configured ? 'cursor-pointer hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover' : 'opacity-60 cursor-not-allowed'
                    }`}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={!configured}
                      onChange={() => {
                        if (!configured) return;
                        setNotifyPlatforms(
                          checked
                            ? notifyPlatforms.filter((p) => p !== platform)
                            : [...notifyPlatforms, platform]
                        );
                      }}
                      className="text-claude-accent focus:ring-claude-accent rounded disabled:cursor-not-allowed"
                    />
                    <span className="text-sm dark:text-claude-darkText text-claude-text">
                      {i18nService.t(`scheduledTasksFormNotify${platform.charAt(0).toUpperCase() + platform.slice(1)}`)}
                    </span>
                    {!configured && (
                      <span className="text-xs text-yellow-600 dark:text-yellow-400 ml-auto">
                        {i18nService.t('scheduledTasksFormNotifyNotConfigured')}
                      </span>
                    )}
                  </label>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
        >
          {i18nService.t('cancel')}
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={submitting}
          className="px-4 py-2 text-sm font-medium bg-claude-accent text-black rounded-lg hover:bg-claude-accentHover transition-colors disabled:opacity-50"
        >
          {submitting
            ? i18nService.t('saving')
            : mode === 'create'
              ? i18nService.t('scheduledTasksFormCreate')
              : i18nService.t('scheduledTasksFormUpdate')}
        </button>
      </div>
    </div>
  );
};

export default TaskForm;
