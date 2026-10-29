import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import { PaperAirplaneIcon, StopIcon, FolderIcon } from '@heroicons/react/24/solid';
import { PhotoIcon } from '@heroicons/react/24/outline';
import PaperClipIcon from '../icons/PaperClipIcon';
import XMarkIcon from '../icons/XMarkIcon';
import ModelSelector from '../ModelSelector';
import FolderSelectorPopover from './FolderSelectorPopover';
import SlashCommandPicker from './SlashCommandPicker';
import FileMentionPicker from './FileMentionPicker';
import { SkillsButton, ActiveSkillBadge } from '../skills';
import { i18nService } from '../../services/i18n';
import { skillService } from '../../services/skill';
import { RootState } from '../../store';
import { setDraftPrompt } from '../../store/slices/coworkSlice';
import { setSkills, toggleActiveSkill } from '../../store/slices/skillSlice';
import { Skill } from '../../types/skill';
import { CoworkImageAttachment } from '../../types/cowork';
import { getCompactFolderName } from '../../utils/path';

type CoworkAttachment = {
  path: string;
  name: string;
  isImage?: boolean;
  dataUrl?: string;
};

const INPUT_FILE_LABEL = '输入文件';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg']);

const isImagePath = (filePath: string): boolean => {
  const dotIndex = filePath.lastIndexOf('.');
  if (dotIndex === -1) return false;
  const ext = filePath.slice(dotIndex).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
};

const isImageMimeType = (mimeType: string): boolean => {
  return mimeType.startsWith('image/');
};

const extractBase64FromDataUrl = (dataUrl: string): { mimeType: string; base64Data: string } | null => {
  const match = /^data:(.+);base64,(.*)$/.exec(dataUrl);
  if (!match) return null;
  return { mimeType: match[1], base64Data: match[2] };
};

const getFileNameFromPath = (path: string): string => {
  const parts = path.split(/[/\\]/);
  return parts[parts.length - 1] || path;
};

const getSkillDirectoryFromPath = (skillPath: string): string => {
  const normalized = skillPath.trim().replace(/\\/g, '/');
  return normalized.replace(/\/SKILL\.md$/i, '') || normalized;
};

const buildInlinedSkillPrompt = (skill: Skill): string => {
  const skillDirectory = getSkillDirectoryFromPath(skill.skillPath);
  return [
    `## Skill: ${skill.name}`,
    '<skill_context>',
    `  <location>${skill.skillPath}</location>`,
    `  <directory>${skillDirectory}</directory>`,
    '  <path_rules>',
    '    Resolve relative file references from this skill against <directory>.',
    '    Do not assume skills are under the current workspace directory.',
    '  </path_rules>',
    '</skill_context>',
    '',
    skill.prompt,
  ].join('\n');
};

export interface CoworkPromptInputRef {
  /** Set input value */
  setValue: (value: string) => void;
  /** Focus the input */
  focus: () => void;
}

interface CoworkPromptInputProps {
  onSubmit: (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => void;
  onStop?: () => void;
  isStreaming?: boolean;
  placeholder?: string;
  disabled?: boolean;
  size?: 'normal' | 'large';
  workingDirectory?: string;
  onWorkingDirectoryChange?: (dir: string) => void;
  showFolderSelector?: boolean;
  showModelSelector?: boolean;
  onManageSkills?: () => void;
}

const CoworkPromptInput = React.forwardRef<CoworkPromptInputRef, CoworkPromptInputProps>(
  (props, ref) => {
    const {
      onSubmit,
      onStop,
      isStreaming = false,
      placeholder = 'Enter your task...',
      disabled = false,
      size = 'normal',
      workingDirectory = '',
      onWorkingDirectoryChange,
      showFolderSelector = false,
      showModelSelector = false,
      onManageSkills,
    } = props;
    const dispatch = useDispatch();
    const draftPrompt = useSelector((state: RootState) => state.cowork.draftPrompt);
    const [value, setValue] = useState(draftPrompt);
    const [attachments, setAttachments] = useState<CoworkAttachment[]>([]);
    const [showFolderMenu, setShowFolderMenu] = useState(false);
    const [showFolderRequiredWarning, setShowFolderRequiredWarning] = useState(false);
    const [isDraggingFiles, setIsDraggingFiles] = useState(false);
    const [isAddingFile, setIsAddingFile] = useState(false);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const folderButtonRef = useRef<HTMLButtonElement>(null);
    const dragDepthRef = useRef(0);

  // Expose methods to parent component
  React.useImperativeHandle(ref, () => ({
    setValue: (newValue: string) => {
      setValue(newValue);
      // Trigger auto-resize height
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
        }
      });
    },
    focus: () => {
      textareaRef.current?.focus();
    },
  }));

  const activeSkillIds = useSelector((state: RootState) => state.skill.activeSkillIds);
  const skills = useSelector((state: RootState) => state.skill.skills);

  const isLarge = size === 'large';
  const minHeight = isLarge ? 140 : 24;
  const maxHeight = isLarge ? 240 : 200;

  // Load skills on mount
  useEffect(() => {
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();
  }, [dispatch]);

  useEffect(() => {
    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      dispatch(setSkills(loadedSkills));
    });
    return () => {
      unsubscribe();
    };
  }, [dispatch]);

  // Auto-resize textarea
  useEffect(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
    }
  }, [value, minHeight, maxHeight]);

  useEffect(() => {
    const handleFocusInput = (event: Event) => {
      const detail = (event as CustomEvent<{ clear?: boolean }>).detail;
      const shouldClear = detail?.clear ?? true;
      if (shouldClear) {
        setValue('');
        setAttachments([]);
      }
      requestAnimationFrame(() => {
        textareaRef.current?.focus();
      });
    };
    window.addEventListener('cowork:focus-input', handleFocusInput);
    return () => {
      window.removeEventListener('cowork:focus-input', handleFocusInput);
    };
  }, []);

  // Listen for command-bar → composer prefill. The floating NSPanel
  // command bar (src/renderer/components/commandBar/CommandBarView.tsx)
  // cannot directly call the composer's imperative handle across Tauri
  // webviews, so it dispatches `noobclaw:prefill-prompt` which App.tsx
  // forwards after switching to the cowork view.
  useEffect(() => {
    const handlePrefill = (event: Event) => {
      const detail = (event as CustomEvent<{ prompt?: string }>).detail;
      if (!detail?.prompt) return;
      setValue(detail.prompt);
      requestAnimationFrame(() => {
        const textarea = textareaRef.current;
        if (textarea) {
          textarea.style.height = 'auto';
          textarea.style.height = `${Math.min(Math.max(textarea.scrollHeight, minHeight), maxHeight)}px`;
          textarea.focus();
          // Put the caret at the end so the user can keep typing.
          const len = textarea.value.length;
          textarea.setSelectionRange(len, len);
        }
      });
    };
    window.addEventListener('noobclaw:prefill-prompt', handlePrefill);
    return () => window.removeEventListener('noobclaw:prefill-prompt', handlePrefill);
  }, [minHeight, maxHeight]);

  useEffect(() => {
    if (workingDirectory?.trim()) {
      setShowFolderRequiredWarning(false);
    }
  }, [workingDirectory]);

  useEffect(() => {
    if (value !== draftPrompt) {
      const timer = setTimeout(() => {
        dispatch(setDraftPrompt(value));
      }, 300);
      return () => clearTimeout(timer);
    }
  }, [value, draftPrompt, dispatch]);

  const handleSubmit = useCallback(() => {
    // In Tauri mode, config may load async — don't block on empty directory
    // (sidecar will use default ~/noobclaw/project)
    if (showFolderSelector && !workingDirectory?.trim() && !(window as any).__TAURI__) {
      setShowFolderRequiredWarning(true);
      return;
    }

    const trimmedValue = value.trim();
    if ((!trimmedValue && attachments.length === 0) || isStreaming || disabled) return;
    setShowFolderRequiredWarning(false);

    // Get active skills prompts and combine them
    const activeSkills = activeSkillIds
      .map(id => skills.find(s => s.id === id))
      .filter((s): s is Skill => s !== undefined);
    const skillPrompt = activeSkills.length > 0
      ? activeSkills.map(buildInlinedSkillPrompt).join('\n\n')
      : undefined;

    // Extract image attachments (with base64 data) for vision-capable models
    const imageAtts: CoworkImageAttachment[] = [];
    for (const attachment of attachments) {
      if (attachment.isImage && attachment.dataUrl) {
        const extracted = extractBase64FromDataUrl(attachment.dataUrl);
        if (extracted) {
          imageAtts.push({
            name: attachment.name,
            mimeType: extracted.mimeType,
            base64Data: extracted.base64Data,
          });
        }
      }
    }

    // Build prompt with ALL attachments that have real file paths (both regular files and images).
    // Image attachments also need their file paths in the prompt so the model knows
    // where the original files are located (e.g., for skills like seedream that need --image <path>).
    // Note: inline/clipboard images have pseudo-paths starting with 'inline:' and are excluded.
    const attachmentLines = attachments
      .filter((a) => !a.path.startsWith('inline:'))
      .map((attachment) => `${INPUT_FILE_LABEL}: ${attachment.path}`)
      .join('\n');
    const finalPrompt = trimmedValue
      ? (attachmentLines ? `${trimmedValue}\n\n${attachmentLines}` : trimmedValue)
      : attachmentLines;

    if (imageAtts.length > 0) {
      console.log('[CoworkPromptInput] handleSubmit: passing imageAtts to onSubmit', {
        count: imageAtts.length,
        names: imageAtts.map(a => a.name),
        base64Lengths: imageAtts.map(a => a.base64Data.length),
      });
    }
    onSubmit(finalPrompt, skillPrompt, imageAtts.length > 0 ? imageAtts : undefined);
    setValue('');
    dispatch(setDraftPrompt(''));
    setAttachments([]);
  }, [value, isStreaming, disabled, onSubmit, activeSkillIds, skills, attachments, showFolderSelector, workingDirectory, dispatch]);

  const handleSelectSkill = useCallback((skill: Skill) => {
    dispatch(toggleActiveSkill(skill.id));
  }, [dispatch]);

  const handleManageSkills = useCallback(() => {
    if (onManageSkills) {
      onManageSkills();
    }
  }, [onManageSkills]);

  // Slash-command autocomplete popup state. Opens when the composer
  // value starts with "/" on the first line and stays open until the
  // user presses space or Escape. Navigation (arrows, Enter/Tab) is
  // forwarded into the popup via slashMenuApiRef so we don't
  // double-handle keys here.
  const slashMenuOpen = /^\/[a-zA-Z0-9_.-]*$/.test(value);
  const slashQuery = slashMenuOpen ? value.slice(1) : '';
  const slashMenuApiRef = React.useRef<{
    moveDown: () => void;
    moveUp: () => void;
    acceptCurrent: () => void;
  } | null>(null);

  // @mention file picker state. Detects an "@foo" token at the
  // current cursor position (not just start-of-value, unlike slash),
  // so the user can drop file references anywhere mid-prompt.
  // The match anchors on either the beginning of the string or a
  // whitespace character so "@" inside an email or code doesn't
  // accidentally trigger it.
  const [cursorPos, setCursorPos] = useState(0);
  const mentionMatch = useMemo(() => {
    if (!workingDirectory) return null;
    const upToCursor = value.slice(0, cursorPos);
    const m = /(^|\s)@([\w./\-]*)$/.exec(upToCursor);
    if (!m) return null;
    return { query: m[2], start: upToCursor.length - m[2].length - 1 };
  }, [value, cursorPos, workingDirectory]);
  const mentionMenuOpen = mentionMatch != null && !slashMenuOpen;
  const mentionMenuApiRef = React.useRef<{
    moveDown: () => void;
    moveUp: () => void;
    acceptCurrent: () => void;
  } | null>(null);

  const handleSelectMention = useCallback((rel: string) => {
    if (!mentionMatch) return;
    const before = value.slice(0, mentionMatch.start);
    const after = value.slice(cursorPos);
    const inserted = `@${rel} `;
    const next = before + inserted + after;
    setValue(next);
    requestAnimationFrame(() => {
      const newPos = (before + inserted).length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(newPos, newPos);
    });
  }, [mentionMatch, value, cursorPos]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // If either autocomplete popup is open, capture navigation keys.
    const activeMenuApi = slashMenuOpen
      ? slashMenuApiRef.current
      : mentionMenuOpen
        ? mentionMenuApiRef.current
        : null;
    if (activeMenuApi) {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        activeMenuApi.moveDown();
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        activeMenuApi.moveUp();
        return;
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault();
        activeMenuApi.acceptCurrent();
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        // Closing the slash menu means clearing the value; closing the
        // mention menu means inserting a space so the "@" no longer
        // matches the trigger regex.
        if (slashMenuOpen) setValue('');
        else if (mentionMenuOpen) setValue(value + ' ');
        return;
      }
    }
    // Enter to submit, Shift+Enter for new line
    const isComposing = event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229;
    if (event.key === 'Enter' && !event.shiftKey && !isComposing && !isStreaming && !disabled) {
      event.preventDefault();
      handleSubmit();
    }
  };

  const handleSelectSlashCommand = useCallback((name: string) => {
    setValue(`/${name} `);
    requestAnimationFrame(() => {
      textareaRef.current?.focus();
      const len = (`/${name} `).length;
      textareaRef.current?.setSelectionRange(len, len);
    });
  }, []);

  const handleStopClick = () => {
    if (onStop) {
      onStop();
    }
  };

  const containerClass = isLarge
    ? 'relative rounded-2xl overflow-hidden border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-card focus-within:shadow-elevated focus-within:ring-1 focus-within:ring-claude-accent/40 focus-within:border-claude-accent'
    : 'relative flex items-end gap-2 p-3 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface';

  const textareaClass = isLarge
    ? `w-full resize-none bg-transparent px-4 pt-3 pb-2 dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary/60 placeholder:text-claude-textSecondary/60 focus:outline-none text-[15px] leading-6 min-h-[${minHeight}px] max-h-[${maxHeight}px]`
    : 'flex-1 resize-none bg-transparent dark:text-claude-darkText text-claude-text placeholder:dark:text-claude-darkTextSecondary placeholder:text-claude-textSecondary focus:outline-none text-sm leading-relaxed min-h-[24px] max-h-[200px]';

  const truncatePath = (path: string, maxLength = 30): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };

  const handleFolderSelect = (path: string) => {
    if (onWorkingDirectoryChange) {
      onWorkingDirectoryChange(path);
    }
  };

  const selectedModel = useSelector((state: RootState) => state.model.selectedModel);
  const modelSupportsImage = !!selectedModel?.supportsImage;

  const addAttachment = useCallback((filePath: string, imageInfo?: { isImage: boolean; dataUrl?: string }) => {
    if (!filePath) return;
    setAttachments((prev) => {
      if (prev.some((attachment) => attachment.path === filePath)) {
        return prev;
      }
      return [...prev, {
        path: filePath,
        name: getFileNameFromPath(filePath),
        isImage: imageInfo?.isImage,
        dataUrl: imageInfo?.dataUrl,
      }];
    });
  }, []);

  const addImageAttachmentFromDataUrl = useCallback((name: string, dataUrl: string) => {
    // Use the dataUrl as the unique key (no file path for inline images)
    const pseudoPath = `inline:${name}:${Date.now()}`;
    setAttachments((prev) => {
      return [...prev, {
        path: pseudoPath,
        name,
        isImage: true,
        dataUrl,
      }];
    });
  }, []);

  const fileToDataUrl = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        resolve(result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const fileToBase64 = useCallback((file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result;
        if (typeof result !== 'string') {
          reject(new Error('Failed to read file'));
          return;
        }
        const commaIndex = result.indexOf(',');
        resolve(commaIndex >= 0 ? result.slice(commaIndex + 1) : result);
      };
      reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }, []);

  const getNativeFilePath = useCallback((file: File): string | null => {
    const maybePath = (file as File & { path?: string }).path;
    if (typeof maybePath === 'string' && maybePath.trim()) {
      return maybePath;
    }
    return null;
  }, []);

  const saveInlineFile = useCallback(async (file: File): Promise<string | null> => {
    try {
      const dataBase64 = await fileToBase64(file);
      if (!dataBase64) {
        return null;
      }
      const result = await window.electron.dialog.saveInlineFile({
        dataBase64,
        fileName: file.name,
        mimeType: file.type,
        cwd: workingDirectory,
      });
      if (result.success && result.path) {
        return result.path;
      }
      return null;
    } catch (error) {
      console.error('Failed to save inline file:', error);
      return null;
    }
  }, [fileToBase64, workingDirectory]);

  // Native drag & drop path (Tauri v2 Rust side dispatches
  // `nc://file-drop` CustomEvent with real fs paths, because HTML5
  // drag-drop in WKWebView only sees browser-style File blobs without
  // paths). tauriShim exposes this as `electron.onFileDrop(cb)`. The
  // Electron build sees no `onFileDrop` method so this effect is a
  // no-op there and the existing HTML5 handler is used instead.
  const handleNativeDroppedPaths = useCallback((paths: string[]) => {
    if (disabled || isStreaming) return;
    if (!Array.isArray(paths) || paths.length === 0) return;
    for (const p of paths) {
      if (!p) continue;
      if (isImagePath(p) && modelSupportsImage) {
        // Read as data URL so vision models can consume inline.
        window.electron.dialog
          .readFileAsDataUrl(p)
          .then((result: { success: boolean; dataUrl?: string }) => {
            if (result?.success && result.dataUrl) {
              addAttachment(p, { isImage: true, dataUrl: result.dataUrl });
            } else {
              addAttachment(p);
            }
          })
          .catch(() => addAttachment(p));
      } else {
        addAttachment(p);
      }
    }
  }, [addAttachment, disabled, isStreaming, modelSupportsImage]);

  useEffect(() => {
    const anyElectron = window.electron as unknown as {
      onFileDrop?: (cb: (paths: string[]) => void) => (() => void) | void;
    };
    if (typeof anyElectron?.onFileDrop !== 'function') return;
    const off = anyElectron.onFileDrop(handleNativeDroppedPaths);
    return () => {
      if (typeof off === 'function') off();
    };
  }, [handleNativeDroppedPaths]);

  const handleIncomingFiles = useCallback(async (fileList: FileList | File[]) => {
    if (disabled || isStreaming) return;
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      const nativePath = getNativeFilePath(file);

      // Check if this is an image file and model supports images
      const fileIsImage = nativePath
        ? isImagePath(nativePath)
        : isImageMimeType(file.type);

      if (fileIsImage && modelSupportsImage) {
        // For images on vision-capable models, read as data URL
        if (nativePath) {
          try {
            const result = await window.electron.dialog.readFileAsDataUrl(nativePath);
            if (result.success && result.dataUrl) {
              addAttachment(nativePath, { isImage: true, dataUrl: result.dataUrl });
              continue;
            }
          } catch (error) {
            console.error('Failed to read image as data URL:', error);
          }
          // Fallback: add as regular file attachment
          addAttachment(nativePath);
        } else {
          // No native path (clipboard/drag from browser) - read via FileReader
          try {
            const dataUrl = await fileToDataUrl(file);
            addImageAttachmentFromDataUrl(file.name, dataUrl);
          } catch (error) {
            console.error('Failed to read image from clipboard:', error);
            const stagedPath = await saveInlineFile(file);
            if (stagedPath) {
              addAttachment(stagedPath);
            }
          }
        }
        continue;
      }

      // Non-image file or model doesn't support images: use original flow
      if (nativePath) {
        addAttachment(nativePath);
        continue;
      }

      const stagedPath = await saveInlineFile(file);
      if (stagedPath) {
        addAttachment(stagedPath);
      }
    }
  }, [addAttachment, addImageAttachmentFromDataUrl, disabled, fileToDataUrl, getNativeFilePath, isStreaming, modelSupportsImage, saveInlineFile]);

  const handleAddFile = useCallback(async () => {
    if (isAddingFile || disabled || isStreaming) return;
    setIsAddingFile(true);
    try {
      const result = await window.electron.dialog.selectFiles({
        title: i18nService.t('coworkAddFile'),
      });
      if (!result.success || result.paths.length === 0) return;
      for (const filePath of result.paths) {
        if (isImagePath(filePath) && modelSupportsImage) {
          try {
            const readResult = await window.electron.dialog.readFileAsDataUrl(filePath);
            if (readResult.success && readResult.dataUrl) {
              addAttachment(filePath, { isImage: true, dataUrl: readResult.dataUrl });
              continue;
            }
          } catch (error) {
            console.error('Failed to read image as data URL:', error);
          }
        }
        addAttachment(filePath);
      }
    } catch (error) {
      console.error('Failed to select file:', error);
    } finally {
      setIsAddingFile(false);
    }
  }, [addAttachment, isAddingFile, disabled, isStreaming, modelSupportsImage]);

  const handleRemoveAttachment = useCallback((path: string) => {
    setAttachments((prev) => prev.filter((attachment) => attachment.path !== path));
  }, []);

  const hasFileTransfer = (dataTransfer: DataTransfer | null): boolean => {
    if (!dataTransfer) return false;
    if (dataTransfer.files.length > 0) return true;
    return Array.from(dataTransfer.types).includes('Files');
  };

  const handleDragEnter = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current += 1;
    if (!disabled && !isStreaming) {
      setIsDraggingFiles(true);
    }
  };

  const handleDragOver = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = disabled || isStreaming ? 'none' : 'copy';
  };

  const handleDragLeave = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) {
      setIsDraggingFiles(false);
    }
  };

  const handleDrop = (event: React.DragEvent<HTMLDivElement>) => {
    if (!hasFileTransfer(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingFiles(false);
    if (disabled || isStreaming) return;
    void handleIncomingFiles(event.dataTransfer.files);
  };

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled || isStreaming) return;
    const files = Array.from(event.clipboardData?.files ?? []);
    if (files.length === 0) return;
    event.preventDefault();
    void handleIncomingFiles(files);
  }, [disabled, handleIncomingFiles, isStreaming]);

  const canSubmit = !disabled && (!!value.trim() || attachments.length > 0);
  const enhancedContainerClass = isDraggingFiles
    ? `${containerClass} ring-2 ring-claude-accent/50 border-claude-accent/60`
    : containerClass;

  return (
    <div className="relative">
      {attachments.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-2">
          {attachments.map((attachment) => (
              <div
                key={attachment.path}
                className="inline-flex items-center gap-1.5 rounded-full border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-2.5 py-1 text-xs dark:text-claude-darkText text-claude-text max-w-full"
                title={attachment.path}
              >
                {attachment.isImage ? (
                  <PhotoIcon className="h-3.5 w-3.5 flex-shrink-0 text-blue-500" />
                ) : (
                  <PaperClipIcon className="h-3.5 w-3.5 flex-shrink-0" />
                )}
                <span className="truncate max-w-[180px]">{attachment.name}</span>
                <button
                  type="button"
                  onClick={() => handleRemoveAttachment(attachment.path)}
                  className="ml-0.5 rounded-full p-0.5 hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                  aria-label={i18nService.t('coworkAttachmentRemove')}
                  title={i18nService.t('coworkAttachmentRemove')}
                >
                  <XMarkIcon className="h-3 w-3" />
                </button>
              </div>
          ))}
        </div>
      )}
      {slashMenuOpen && (
        <SlashCommandPicker
          query={slashQuery}
          onSelect={handleSelectSlashCommand}
          onClose={() => setValue('')}
          forwardRef={slashMenuApiRef}
        />
      )}
      {mentionMenuOpen && mentionMatch && (
        <FileMentionPicker
          query={mentionMatch.query}
          workingDirectory={workingDirectory || ''}
          onSelect={handleSelectMention}
          onClose={() => setValue(value + ' ')}
          forwardRef={mentionMenuApiRef}
        />
      )}
      <div
        className={enhancedContainerClass}
        onDragEnter={handleDragEnter}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        {isDraggingFiles && (
          <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-claude-accent/10 text-xs font-medium text-claude-accent">
            {i18nService.t('coworkDropFileHint')}
          </div>
        )}
        {isLarge ? (
          <>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setCursorPos(e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyUp={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onClick={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={isLarge ? 2 : 1}
              className={textareaClass}
              style={{ minHeight: `${minHeight}px` }}
            />
            <div className="flex items-center justify-between px-4 pb-2 pt-1.5">
              <div className="flex items-center gap-2 relative">
                {showFolderSelector && (
                  <>
                    <div className="relative group">
                      <button
                        ref={folderButtonRef as React.RefObject<HTMLButtonElement>}
                        type="button"
                        onClick={() => setShowFolderMenu(!showFolderMenu)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                      >
                        <FolderIcon className="h-4 w-4" />
                        <span className="max-w-[150px] truncate text-xs">
                          {truncatePath(workingDirectory)}
                        </span>
                      </button>
                      {/* Tooltip - hidden when folder menu is open */}
                      {!showFolderMenu && (
                        <div className="absolute left-1/2 -translate-x-1/2 bottom-full mb-2 px-3.5 py-2.5 text-[13px] leading-relaxed rounded-xl shadow-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:border-claude-darkBorder border-claude-border border opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200 pointer-events-none z-50 max-w-[400px] break-all whitespace-nowrap">
                          {truncatePath(workingDirectory, 120)}
                        </div>
                      )}
                    </div>
                    <FolderSelectorPopover
                      isOpen={showFolderMenu}
                      onClose={() => setShowFolderMenu(false)}
                      onSelectFolder={handleFolderSelect}
                      anchorRef={folderButtonRef as React.RefObject<HTMLElement>}
                    />
                  </>
                )}
                {showModelSelector && <ModelSelector dropdownDirection="up" />}
                <button
                  type="button"
                  onClick={handleAddFile}
                  className="flex items-center justify-center p-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                  title={i18nService.t('coworkAddFile')}
                  aria-label={i18nService.t('coworkAddFile')}
                  disabled={disabled || isStreaming || isAddingFile}
                >
                  <PaperClipIcon className="h-4 w-4" />
                </button>
                <SkillsButton
                  onSelectSkill={handleSelectSkill}
                  onManageSkills={handleManageSkills}
                  dropdownDirection="up"
                />
                <ActiveSkillBadge />
              </div>
              <div className="flex items-center gap-2">
                {isStreaming ? (
                  <button
                    type="button"
                    onClick={handleStopClick}
                    className="p-2 rounded-xl bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                    aria-label="Stop"
                  >
                    <StopIcon className="h-5 w-5" />
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={handleSubmit}
                    disabled={!canSubmit}
                    className="p-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-black transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                    aria-label="Send"
                  >
                    <PaperAirplaneIcon className="h-5 w-5" />
                  </button>
                )}
              </div>
            </div>
          </>
        ) : (
          <>
            <textarea
              ref={textareaRef}
              value={value}
              onChange={(e) => {
                setValue(e.target.value);
                setCursorPos(e.target.selectionStart ?? e.target.value.length);
              }}
              onKeyUp={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onClick={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onSelect={(e) => setCursorPos((e.target as HTMLTextAreaElement).selectionStart ?? 0)}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={placeholder}
              disabled={disabled}
              rows={1}
              className={textareaClass}
            />

            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={handleAddFile}
                className="flex-shrink-0 p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
                title={i18nService.t('coworkAddFile')}
                aria-label={i18nService.t('coworkAddFile')}
                disabled={disabled || isStreaming || isAddingFile}
              >
                <PaperClipIcon className="h-4 w-4" />
              </button>
            </div>

            {isStreaming ? (
              <button
                type="button"
                onClick={handleStopClick}
                className="flex-shrink-0 p-2 rounded-lg bg-red-500 hover:bg-red-600 text-white transition-all shadow-subtle hover:shadow-card active:scale-95"
                aria-label="Stop"
              >
                <StopIcon className="h-4 w-4" />
              </button>
            ) : (
              <button
                type="button"
                onClick={handleSubmit}
                disabled={!canSubmit}
                className="flex-shrink-0 p-2 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-black transition-all shadow-subtle hover:shadow-card active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed"
                aria-label="Send"
              >
                <PaperAirplaneIcon className="h-4 w-4" />
              </button>
            )}
          </>
        )}
      </div>
      {showFolderRequiredWarning && (
        <div className="mt-2 text-xs text-red-500 dark:text-red-400">
          {i18nService.t('coworkSelectFolderFirst')}
        </div>
      )}
    </div>
  );
  }
);

CoworkPromptInput.displayName = 'CoworkPromptInput';

export default CoworkPromptInput;
