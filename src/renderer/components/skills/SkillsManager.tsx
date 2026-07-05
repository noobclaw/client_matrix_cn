import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDispatch, useSelector } from 'react-redux';
import {
  ArrowDownTrayIcon,
  CheckCircleIcon,
  XMarkIcon,
} from '@heroicons/react/24/outline';
import SearchIcon from '../icons/SearchIcon';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import UploadIcon from '../icons/UploadIcon';
import FolderOpenIcon from '../icons/FolderOpenIcon';
import LinkIcon from '../icons/LinkIcon';
import PuzzleIcon from '../icons/PuzzleIcon';
import TrashIcon from '../icons/TrashIcon';
import { i18nService } from '../../services/i18n';
import { skillService, resolveLocalizedText } from '../../services/skill';
import { setSkills } from '../../store/slices/skillSlice';
import { RootState } from '../../store';
import { Skill, MarketplaceSkill, MarketTag, SkillPack } from '../../types/skill';
import ErrorMessage from '../ErrorMessage';

type SkillTab = 'installed' | 'marketplace' | 'packs';

const SkillsManager: React.FC = () => {
  const dispatch = useDispatch();
  const skills = useSelector((state: RootState) => state.skill.skills);

  const [skillSearchQuery, setSkillSearchQuery] = useState('');
  const [skillDownloadSource, setSkillDownloadSource] = useState('');
  const [skillActionError, setSkillActionError] = useState('');
  const [isDownloadingSkill, setIsDownloadingSkill] = useState(false);
  const [isAddSkillMenuOpen, setIsAddSkillMenuOpen] = useState(false);
  const [isGithubImportOpen, setIsGithubImportOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<SkillTab>('installed');
  const [marketplaceSkills, setMarketplaceSkills] = useState<MarketplaceSkill[]>([]);
  const [marketTags, setMarketTags] = useState<MarketTag[]>([]);
  const [activeMarketTag, setActiveMarketTag] = useState('all');
  const [isLoadingMarketplace, setIsLoadingMarketplace] = useState(false);
  const [marketPage, setMarketPage] = useState(1);
  const [, setMarketTotal] = useState(0);
  const [marketTotalPages, setMarketTotalPages] = useState(0);
  const marketPageSize = 20;
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null);
  const [selectedMarketplaceSkill, setSelectedMarketplaceSkill] = useState<MarketplaceSkill | null>(null);
  const [selectedSkill, setSelectedSkill] = useState<Skill | null>(null);
  const [skillPendingDelete, setSkillPendingDelete] = useState<Skill | null>(null);
  const [isDeletingSkill, setIsDeletingSkill] = useState(false);

  // Skill packs state
  const [skillPacks, setSkillPacks] = useState<SkillPack[]>([]);
  const [installingPack, setInstallingPack] = useState<string | null>(null);
  const [packInstallProgress, setPackInstallProgress] = useState<{ current: number; total: number } | null>(null);
  const [collapsedPacks, setCollapsedPacks] = useState<Set<string>>(new Set());

  const addSkillMenuRef = useRef<HTMLDivElement>(null);
  const addSkillButtonRef = useRef<HTMLButtonElement>(null);
  const githubImportInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let isActive = true;
    const loadSkills = async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
    };
    loadSkills();

    const unsubscribe = skillService.onSkillsChanged(async () => {
      const loadedSkills = await skillService.loadSkills();
      if (!isActive) return;
      dispatch(setSkills(loadedSkills));
    });

    return () => {
      isActive = false;
      unsubscribe();
    };
  }, [dispatch]);

  const fetchMarketplace = useCallback(async (page: number, tag: string, search: string) => {
    setIsLoadingMarketplace(true);
    const data = await skillService.fetchMarketplaceSkills({
      page,
      pageSize: marketPageSize,
      tag: tag === 'all' ? undefined : tag,
      search: search || undefined,
    });
    setMarketplaceSkills(data.skills);
    setMarketTags(data.tags);
    setMarketPage(data.pagination.page);
    setMarketTotal(data.pagination.total);
    setMarketTotalPages(data.pagination.totalPages);
    setIsLoadingMarketplace(false);
  }, [marketPageSize]);

  useEffect(() => {
    fetchMarketplace(1, activeMarketTag, activeTab === 'marketplace' ? skillSearchQuery : '');
    // Also fetch skill packs
    skillService.fetchSkillPacks().then(packs => {
      setSkillPacks(packs);
      setCollapsedPacks(new Set(packs.map(p => p.author)));
    });
  }, []);

  // Re-fetch when tag changes (marketplace tab)
  useEffect(() => {
    if (activeTab === 'marketplace') {
      fetchMarketplace(1, activeMarketTag, skillSearchQuery);
    }
  }, [activeMarketTag]);

  // Re-fetch packs when switching to packs tab
  useEffect(() => {
    if (activeTab === 'packs') {
      skillService.fetchSkillPacks().then(packs => setSkillPacks(packs));
    }
  }, [activeTab]);

  useEffect(() => {
    if (!isAddSkillMenuOpen) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const isInsideMenu = addSkillMenuRef.current?.contains(target);
      const isInsideButton = addSkillButtonRef.current?.contains(target);
      if (!isInsideMenu && !isInsideButton) {
        setIsAddSkillMenuOpen(false);
      }
    };

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsAddSkillMenuOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isAddSkillMenuOpen]);

  useEffect(() => {
    if (!isGithubImportOpen) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsGithubImportOpen(false);
      }
    };

    document.addEventListener('keydown', handleEscape);
    setTimeout(() => githubImportInputRef.current?.focus(), 0);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isGithubImportOpen]);

  useEffect(() => {
    const hasOpenDialog = selectedSkill || selectedMarketplaceSkill;
    if (!hasOpenDialog) return;

    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (selectedSkill) setSelectedSkill(null);
        if (selectedMarketplaceSkill) setSelectedMarketplaceSkill(null);
      }
    };

    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('keydown', handleEscape);
    };
  }, [selectedSkill, selectedMarketplaceSkill]);

  const filteredSkills = useMemo(() => {
    const query = skillSearchQuery.toLowerCase();
    return skills.filter(skill => {
      const matchesSearch = skill.name.toLowerCase().includes(query)
        || skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description, skill).toLowerCase().includes(query);
      return matchesSearch;
    });
  }, [skills, skillSearchQuery]);

  // Debounced search for marketplace
  const marketSearchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (activeTab !== 'marketplace') return;
    if (marketSearchTimerRef.current) clearTimeout(marketSearchTimerRef.current);
    marketSearchTimerRef.current = setTimeout(() => {
      fetchMarketplace(1, activeMarketTag, skillSearchQuery);
    }, 300);
    return () => { if (marketSearchTimerRef.current) clearTimeout(marketSearchTimerRef.current); };
  }, [skillSearchQuery, activeTab]);

  // Marketplace filtering is now server-side; use fetched results directly
  const filteredMarketplaceSkills = marketplaceSkills;

  const formatSkillDate = (timestamp: number) => {
    const date = new Date(timestamp);
    const locale = i18nService.getDateLocale();
    return new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }).format(date);
  };

  const handleToggleSkill = async (skillId: string) => {
    const targetSkill = skills.find(skill => skill.id === skillId);
    if (!targetSkill) return;
    try {
      const updatedSkills = await skillService.setSkillEnabled(skillId, !targetSkill.enabled);
      dispatch(setSkills(updatedSkills));
      setSkillActionError('');
    } catch (error) {
      setSkillActionError(error instanceof Error ? error.message : i18nService.t('skillUpdateFailed'));
    }
  };

  const handleRequestDeleteSkill = (skill: Skill) => {
    if (skill.isBuiltIn) {
      setSkillActionError(i18nService.t('skillBuiltInCannotDelete'));
      return;
    }
    setSkillActionError('');
    setSkillPendingDelete(skill);
  };

  const handleCancelDeleteSkill = () => {
    if (isDeletingSkill) return;
    setSkillPendingDelete(null);
  };

  const handleConfirmDeleteSkill = async () => {
    if (!skillPendingDelete || isDeletingSkill) return;
    setIsDeletingSkill(true);
    setSkillActionError('');
    const result = await skillService.deleteSkill(skillPendingDelete.id);
    if (!result.success) {
      setSkillActionError(result.error || i18nService.t('skillDeleteFailed'));
      setIsDeletingSkill(false);
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    setIsDeletingSkill(false);
    setSkillPendingDelete(null);
  };

  const handleAddSkillFromSource = async (source: string) => {
    const trimmedSource = source.trim();
    if (!trimmedSource) return;
    setIsDownloadingSkill(true);
    setSkillActionError('');
    const result = await skillService.downloadSkill(trimmedSource);
    setIsDownloadingSkill(false);
    if (!result.success) {
      setSkillActionError(result.error || i18nService.t('skillDownloadFailed'));
      return;
    }
    if (result.skills) {
      dispatch(setSkills(result.skills));
    }
    setSkillDownloadSource('');
    setIsAddSkillMenuOpen(false);
    setIsGithubImportOpen(false);
  };

  const handleUploadSkillZip = async () => {
    if (isDownloadingSkill) return;
    const result = await window.electron.dialog.selectFile({
      title: i18nService.t('uploadSkillZip'),
      filters: [{ name: 'Zip', extensions: ['zip'] }],
    });
    if (result.success && result.path) {
      await handleAddSkillFromSource(result.path);
    }
  };

  const handleUploadSkillFolder = async () => {
    if (isDownloadingSkill) return;
    const result = await window.electron.dialog.selectDirectory();
    if (result.success && result.path) {
      await handleAddSkillFromSource(result.path);
    }
  };

  const handleOpenGithubImport = () => {
    setIsAddSkillMenuOpen(false);
    setSkillActionError('');
    setIsGithubImportOpen(true);
  };

  const handleImportFromGithub = async () => {
    if (isDownloadingSkill) return;
    await handleAddSkillFromSource(skillDownloadSource);
  };

  const isSkillInstalled = (marketplaceSkill: MarketplaceSkill) => {
    const mId = marketplaceSkill.id.toLowerCase();
    const mName = marketplaceSkill.name.toLowerCase();
    const mNameZh = (marketplaceSkill.name_zh || '').toLowerCase();
    // Derive the folder name that downloadSkill would produce from the URL
    // e.g. URL ".../skills/binance/derivatives-trading-usds-futures" -> folder "derivatives-trading-usds-futures"
    const urlFolderName = marketplaceSkill.url
      ? marketplaceSkill.url.replace(/[#?].*$/, '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() || ''
      : '';
    return skills.some(s => {
      const sId = s.id.toLowerCase();
      const sName = s.name.toLowerCase();
      const sNameZh = (s.name_zh || '').toLowerCase();
      return sId === mId || sId === mName || sName === mName || sName === mId
        || (urlFolderName && sId === urlFolderName)
        || (mNameZh && (sName === mNameZh || sId === mNameZh || sNameZh === mNameZh))
        || (sNameZh && (sNameZh === mName || sNameZh === mId));
    });
  };

  const [installSuccessName, setInstallSuccessName] = useState<string | null>(null);

  const handleInstallMarketplaceSkill = async (skill: MarketplaceSkill) => {
    if (installingSkillId || !skill.url) return;
    if (isSkillInstalled(skill)) {
      setSkillActionError(i18nService.t('skillAlreadyInstalledError', { name: skillService.getLocalizedSkillName(skill) }));
      return;
    }
    setInstallingSkillId(skill.id);
    setSkillActionError('');
    setInstallSuccessName(null);
    try {
      const result = await skillService.downloadSkill(skill.url, { official: skill.is_official || false, skillId: skill.id });
      if (!result.success) {
        setSkillActionError(result.error || i18nService.t('skillInstallFailed'));
        return;
      }
      if (result.skills) {
        dispatch(setSkills(result.skills));
      }
      setInstallSuccessName(skillService.getLocalizedSkillName(skill));
      setTimeout(() => setInstallSuccessName(null), 3000);
    } catch {
      setSkillActionError(i18nService.t('skillInstallFailed'));
    } finally {
      setInstallingSkillId(null);
    }
  };

  const isPackAllInstalled = (pack: SkillPack) => {
    return pack.skills.every(s => isSkillInstalled(s));
  };

  const handleInstallPack = async (pack: SkillPack) => {
    if (installingPack) return;
    const toInstall = pack.skills.filter(s => !isSkillInstalled(s));
    if (toInstall.length === 0) return;
    setInstallingPack(pack.author);
    setPackInstallProgress({ current: 0, total: toInstall.length });
    setSkillActionError('');
    try {
      for (let i = 0; i < toInstall.length; i++) {
        setPackInstallProgress({ current: i + 1, total: toInstall.length });
        const result = await skillService.downloadSkill(toInstall[i].url, { official: toInstall[i].is_official || false, skillId: toInstall[i].id });
        if (result.skills) {
          dispatch(setSkills(result.skills));
        }
      }
      setInstallSuccessName(`${pack.author} (${toInstall.length})`);
      setTimeout(() => setInstallSuccessName(null), 3000);
    } catch {
      setSkillActionError(i18nService.t('skillInstallFailed'));
    } finally {
      setInstallingPack(null);
      setPackInstallProgress(null);
    }
  };

  // Helper: find the matching marketplace skill for an installed skill
  const findMarketplaceMatch = useCallback((skill: Skill): MarketplaceSkill | undefined => {
    const sId = skill.id.toLowerCase();
    const sName = skill.name.toLowerCase();
    const sNameZh = (skill.name_zh || '').toLowerCase();
    // Check all marketplace sources: current page + all packs
    const allMarket: MarketplaceSkill[] = [...marketplaceSkills];
    for (const pack of skillPacks) {
      for (const ms of pack.skills) {
        if (!allMarket.some(m => m.id === ms.id)) allMarket.push(ms);
      }
    }
    return allMarket.find(m => {
      const mId = m.id.toLowerCase();
      const mName = m.name.toLowerCase();
      const mNameZh = (m.name_zh || '').toLowerCase();
      const urlFolder = m.url ? m.url.replace(/[#?].*$/, '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() || '' : '';
      return sId === mId || sId === mName || sName === mName || sName === mId
        || (urlFolder && sId === urlFolder)
        || (mNameZh && (sName === mNameZh || sId === mNameZh))
        || (sNameZh && (sNameZh === mName || sNameZh === mId));
    });
  }, [marketplaceSkills, skillPacks]);

  // Get localized skill name, falling back to marketplace name_zh if local skill doesn't have it
  const getInstalledSkillName = useCallback((skill: Skill): string => {
    if (skill.name_zh && i18nService.getLanguage() === 'zh') return skill.name_zh;
    if (i18nService.getLanguage() === 'zh') {
      const mp = findMarketplaceMatch(skill);
      if (mp?.name_zh) return mp.name_zh;
    }
    return skill.name;
  }, [findMarketplaceMatch]);

  // Get localized skill description, falling back to marketplace data
  const getInstalledSkillDescription = useCallback((skill: Skill): string => {
    const localDesc = skillService.getLocalizedSkillDescription(skill.id, skill.name, skill.description, skill);
    if (localDesc !== skill.description || i18nService.getLanguage() !== 'zh') return localDesc;
    // Try marketplace
    const mp = findMarketplaceMatch(skill);
    if (mp?.description) return resolveLocalizedText(mp.description);
    return localDesc;
  }, [findMarketplaceMatch]);

  // Group installed skills by packId / source_author for display
  const groupedInstalledSkills = useMemo(() => {
    const groups = new Map<string, Skill[]>();
    const ungrouped: Skill[] = [];
    // Build a mapping from skill id/name to pack author from marketplace packs
    const idToAuthor = new Map<string, string>();
    for (const pack of skillPacks) {
      for (const ms of pack.skills) {
        idToAuthor.set(ms.id.toLowerCase(), pack.author);
        idToAuthor.set(ms.name.toLowerCase(), pack.author);
        if (ms.name_zh) idToAuthor.set(ms.name_zh.toLowerCase(), pack.author);
        // Also map the URL-derived folder name
        if (ms.url) {
          const urlFolder = ms.url.replace(/[#?].*$/, '').replace(/\/+$/, '').split('/').pop()?.toLowerCase() || '';
          if (urlFolder) idToAuthor.set(urlFolder, pack.author);
        }
      }
    }
    for (const skill of filteredSkills) {
      const author = idToAuthor.get(skill.id.toLowerCase())
        || idToAuthor.get(skill.name.toLowerCase())
        || (skill.name_zh ? idToAuthor.get(skill.name_zh.toLowerCase()) : undefined);
      if (author) {
        if (!groups.has(author)) groups.set(author, []);
        groups.get(author)!.push(skill);
      } else {
        ungrouped.push(skill);
      }
    }
    return { groups, ungrouped };
  }, [filteredSkills, skillPacks]);

  const [expandedInstalledGroup, setExpandedInstalledGroup] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('skillsDescription')}
        </p>
      </div>

      {skillActionError && (
        <ErrorMessage
          message={skillActionError}
          onClose={() => setSkillActionError('')}
        />
      )}

      {installSuccessName && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-[9999] flex items-center gap-2 px-5 py-2.5 rounded-full bg-green-600 text-white text-sm shadow-lg animate-fade-in-up">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" viewBox="0 0 24 24" strokeWidth={2} stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          {i18nService.currentLanguage === 'zh' ? `「${installSuccessName}」安装成功` : `"${installSuccessName}" installed`}
        </div>
      )}

      <div className="flex items-center gap-3">
        <div className="relative flex-1">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
          <input
            type="text"
            placeholder={i18nService.t('searchSkills')}
            value={skillSearchQuery}
            onChange={(e) => setSkillSearchQuery(e.target.value)}
            className="w-full pl-9 pr-3 py-2 text-sm rounded-xl dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
          />
        </div>
        <div className="relative">
          <button
            ref={addSkillButtonRef}
            type="button"
            onClick={() => setIsAddSkillMenuOpen(prev => !prev)}
            className="px-3 py-2 text-sm rounded-xl border transition-colors dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover flex items-center gap-2"
          >
            <PlusCircleIcon className="h-4 w-4" />
            <span>{i18nService.t('addSkill')}</span>
          </button>

          {isAddSkillMenuOpen && (
            <div
              ref={addSkillMenuRef}
              className="absolute right-0 mt-2 w-72 rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-lg z-50 overflow-hidden"
            >
              <button
                type="button"
                onClick={handleUploadSkillZip}
                disabled={isDownloadingSkill}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
              >
                <UploadIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('uploadSkillZip')}</span>
              </button>
              <button
                type="button"
                onClick={handleUploadSkillFolder}
                disabled={isDownloadingSkill}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-50"
              >
                <FolderOpenIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('uploadSkillFolder')}</span>
              </button>
              <button
                type="button"
                onClick={handleOpenGithubImport}
                className="w-full flex items-center gap-3 px-3 py-2.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                <LinkIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                <span>{i18nService.t('importFromGithub')}</span>
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center border-b dark:border-claude-darkBorder border-claude-border">
        <button
          type="button"
          onClick={() => setActiveTab('installed')}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            activeTab === 'installed'
              ? 'dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('skillInstalled')}
          {skills.length > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
              {skills.length}
            </span>
          )}
          <div className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
            activeTab === 'installed' ? 'bg-claude-accent' : 'bg-transparent'
          }`} />
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('marketplace')}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            activeTab === 'marketplace'
              ? 'dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('skillMarketplace')}
          <div className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
            activeTab === 'marketplace' ? 'bg-claude-accent' : 'bg-transparent'
          }`} />
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('packs')}
          className={`px-4 py-2 text-sm font-medium transition-colors relative ${
            activeTab === 'packs'
              ? 'dark:text-claude-darkText text-claude-text'
              : 'dark:text-claude-darkTextSecondary text-claude-textSecondary hover:dark:text-claude-darkText hover:text-claude-text'
          }`}
        >
          {i18nService.t('skillPacks')}
          {skillPacks.length > 0 && (
            <span className="ml-1.5 text-[10px] px-1.5 py-0.5 rounded-full dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover">
              {skillPacks.length}
            </span>
          )}
          <div className={`absolute bottom-0 left-0 right-0 h-0.5 rounded-full transition-colors ${
            activeTab === 'packs' ? 'bg-claude-accent' : 'bg-transparent'
          }`} />
        </button>
      </div>

      {activeTab === 'installed' && (
      <div className="space-y-3">
        {filteredSkills.length === 0 ? (
          <div className="text-center py-8 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('noSkillsAvailable')}
          </div>
        ) : (
          <>
            {/* Grouped skills (skill packs) */}
            {Array.from(groupedInstalledSkills.groups.entries()).map(([author, groupSkills]) => {
              const isGroupExpanded = expandedInstalledGroup === author;
              const allEnabled = groupSkills.every(s => s.enabled);
              return (
                <div key={`group-${author}`} className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 overflow-hidden">
                  <div
                    className="flex items-center justify-between p-3 cursor-pointer hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                    onClick={() => setExpandedInstalledGroup(isGroupExpanded ? null : author)}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                        <PuzzleIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                      </div>
                      <span className="text-sm font-medium dark:text-claude-darkText text-claude-text">
                        {author} Skills
                      </span>
                      <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-blue-500/15 text-blue-400">
                        {groupSkills.length}
                      </span>
                      {(() => {
                        const firstMp = findMarketplaceMatch(groupSkills[0]);
                        if (firstMp?.is_official || groupSkills[0]?.isOfficial) return (
                          <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-claude-accent/10 text-claude-accent">
                            {i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}
                          </span>
                        );
                        return null;
                      })()}
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      <div
                        className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                          allEnabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                        }`}
                        onClick={(e) => {
                          e.stopPropagation();
                          const newEnabled = !allEnabled;
                          groupSkills.forEach(s => {
                            if (s.enabled !== newEnabled) handleToggleSkill(s.id);
                          });
                        }}
                      >
                        <div className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                          allEnabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                        }`} />
                      </div>
                      <svg className={`w-4 h-4 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${isGroupExpanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </div>
                  </div>
                  {isGroupExpanded && (
                    <div className="border-t dark:border-claude-darkBorder border-claude-border grid grid-cols-2 gap-2 p-2">
                      {groupSkills.map((skill) => (
                        <div
                          key={skill.id}
                          className="rounded-lg border dark:border-claude-darkBorder/50 border-claude-border/50 p-2.5 transition-colors hover:border-claude-accent/50 cursor-pointer"
                          onClick={() => setSelectedSkill(skill)}
                        >
                          <div className="flex items-center justify-between mb-1.5">
                            <span className="text-xs font-medium dark:text-claude-darkText text-claude-text truncate">
                              {getInstalledSkillName(skill)}
                            </span>
                            <div className="flex items-center gap-1.5 flex-shrink-0">
                              {!skill.isBuiltIn && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); handleRequestDeleteSkill(skill); }}
                                  className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                                >
                                  <TrashIcon className="h-3.5 w-3.5" />
                                </button>
                              )}
                              <div
                                className={`w-8 h-4 rounded-full flex items-center transition-colors cursor-pointer ${
                                  skill.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                                }`}
                                onClick={(e) => { e.stopPropagation(); handleToggleSkill(skill.id); }}
                              >
                                <div className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                                  skill.enabled ? 'translate-x-[16px]' : 'translate-x-[2px]'
                                }`} />
                              </div>
                            </div>
                          </div>
                          <p className="text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-1.5">
                            {getInstalledSkillDescription(skill)}
                          </p>
                          <div className="flex items-center gap-1.5 text-[9px] dark:text-claude-darkTextSecondary text-claude-textSecondary flex-wrap">
                            {(() => {
                              const mp = findMarketplaceMatch(skill);
                              const authorName = mp?.source?.author;
                              return (
                                <>
                                  {authorName && (
                                    <span className="px-1 py-0.5 rounded bg-gray-500/15 text-gray-400 font-medium">{authorName}</span>
                                  )}
                                  {skill.updatedAt && (
                                    <><span>·</span><span>{formatSkillDate(skill.updatedAt)}</span></>
                                  )}
                                  {mp?.source?.url?.includes('github.com') && (
                                    <><span>·</span><span className="px-1 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">{i18nService.currentLanguage === 'zh' ? '开源' : 'OSS'}</span></>
                                  )}
                                  {(skill.isOfficial || mp?.is_official) && (
                                    <><span>·</span><span className="px-1 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium">{i18nService.currentLanguage === 'zh' ? '官方' : 'Official'}</span></>
                                  )}
                                </>
                              );
                            })()}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
            {/* Ungrouped skills */}
            <div className="grid grid-cols-2 gap-3">
              {groupedInstalledSkills.ungrouped.map((skill) => (
                <div
                  key={skill.id}
                  className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50 cursor-pointer"
                  onClick={() => setSelectedSkill(skill)}
                >
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2 min-w-0">
                      <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                        <PuzzleIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                      </div>
                      <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                        {getInstalledSkillName(skill)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {!skill.isBuiltIn && (
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); handleRequestDeleteSkill(skill); }}
                          className="p-1 rounded-lg text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-red-500 dark:hover:text-red-400 transition-colors"
                          title={i18nService.t('deleteSkill')}
                        >
                          <TrashIcon className="h-4 w-4" />
                        </button>
                      )}
                      <div
                        className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                          skill.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                        }`}
                        onClick={(e) => { e.stopPropagation(); handleToggleSkill(skill.id); }}
                      >
                        <div
                          className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                            skill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                          }`}
                        />
                      </div>
                    </div>
                  </div>

                  <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                    {getInstalledSkillDescription(skill)}
                  </p>

                  <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary flex-wrap">
                    {skill.version && (
                      <>
                        <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                          v{skill.version}
                        </span>
                        <span>·</span>
                      </>
                    )}
                    {(() => {
                      const mp = findMarketplaceMatch(skill);
                      const authorName = mp?.source?.author;
                      if (authorName) {
                        return <><span className="px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400 font-medium">{authorName}</span><span>·</span></>;
                      }
                      if (skill.isBuiltIn) return <><span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-400 font-medium">{i18nService.currentLanguage === 'zh' ? '内置' : 'Built-in'}</span><span>·</span></>;
                      if (mp?.source?.from) return <><span className="px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400 font-medium">{mp.source.from}</span><span>·</span></>;
                      if (!skill.isOfficial) return <><span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-400 font-medium">{i18nService.currentLanguage === 'zh' ? '社区' : 'Community'}</span><span>·</span></>;
                      return null;
                    })()}
                    <span>{formatSkillDate(skill.updatedAt)}</span>
                    {(() => {
                      const mp = findMarketplaceMatch(skill);
                      if (mp?.source?.url?.includes('github.com')) return <><span>·</span><span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">{i18nService.currentLanguage === 'zh' ? '开源认证' : 'Open Source'}</span></>;
                      return null;
                    })()}
                    {(() => {
                      const mp = findMarketplaceMatch(skill);
                      if (skill.isOfficial || mp?.is_official) return (
                        <>
                          <span>·</span>
                          <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium">
                            {i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}
                          </span>
                        </>
                      );
                      return null;
                    })()}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      )}

      {activeTab === 'marketplace' && (
        isLoadingMarketplace ? (
          <div className="text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('downloadingSkill')}
          </div>
        ) : (
          <>
            {marketTags.length > 0 && (
              <div className="flex items-center gap-1.5 mb-4 flex-wrap">
                <button
                  type="button"
                  onClick={() => setActiveMarketTag('all')}
                  className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                    activeMarketTag === 'all'
                      ? 'bg-claude-accent text-white'
                      : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover border dark:border-claude-darkBorder border-claude-border'
                  }`}
                >
                  {i18nService.t('skillCategoryAll')}
                </button>
                {marketTags.map((tag) => (
                  <button
                    key={tag.id}
                    type="button"
                    onClick={() => setActiveMarketTag(tag.id)}
                    className={`px-2.5 py-1 text-xs rounded-lg transition-colors ${
                      activeMarketTag === tag.id
                        ? 'bg-claude-accent text-white'
                        : 'dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover border dark:border-claude-darkBorder border-claude-border'
                    }`}
                  >
                    {resolveLocalizedText(tag)}
                  </button>
                ))}
              </div>
            )}
            {filteredMarketplaceSkills.length === 0 ? (
              <div className="text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('skillMarketplaceEmpty')}
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                {filteredMarketplaceSkills.map((skill) => (
              <div
                key={skill.id}
                className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50 cursor-pointer"
                onClick={() => setSelectedMarketplaceSkill(skill)}
              >
                <div className="flex items-start justify-between mb-2">
                  <div className="flex items-center gap-2 min-w-0">
                    <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                      <PuzzleIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                    </div>
                    <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                      {skillService.getLocalizedSkillName(skill)}
                    </span>
                  </div>
                  <div className="flex-shrink-0">
                    {isSkillInstalled(skill) ? (
                      <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-green-600 dark:text-green-400 bg-green-500/10">
                        <CheckCircleIcon className="h-3.5 w-3.5" />
                        {i18nService.t('skillAlreadyInstalled')}
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); handleInstallMarketplaceSkill(skill); }}
                        disabled={installingSkillId !== null}
                        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                        {installingSkillId === skill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
                      </button>
                    )}
                  </div>
                </div>

                <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                  {resolveLocalizedText(skill.description)}
                </p>

                <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary flex-wrap">
                  {skill.source?.author ? (
                    <>
                      <span className="px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400 font-medium">
                        {skill.source.author}
                      </span>
                      <span>·</span>
                    </>
                  ) : skill.source?.from ? (
                    <>
                      <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                        {skill.source.from}
                      </span>
                      <span>·</span>
                    </>
                  ) : null}
                  {skill.version && (
                    <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                      v{skill.version}
                    </span>
                  )}
                  {skill.source?.url?.includes('github.com') && (
                    <>
                      <span>·</span>
                      <span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">{i18nService.currentLanguage === 'zh' ? '开源认证' : 'Open Source'}</span>
                    </>
                  )}
                  {skill.is_official && (
                    <>
                      <span>·</span>
                      <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium">{i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}</span>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
            )}

            {/* Pagination */}
            {marketTotalPages > 1 && (
              <div className="flex items-center justify-center gap-3 pt-3">
                <button
                  disabled={marketPage <= 1 || isLoadingMarketplace}
                  onClick={() => fetchMarketplace(marketPage - 1, activeMarketTag, skillSearchQuery)}
                  className="px-3 py-1.5 rounded-lg text-xs dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 disabled:opacity-40 transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  {i18nService.t('skillsPrevPage')}
                </button>
                <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {marketPage} / {marketTotalPages}
                </span>
                <button
                  disabled={marketPage >= marketTotalPages || isLoadingMarketplace}
                  onClick={() => fetchMarketplace(marketPage + 1, activeMarketTag, skillSearchQuery)}
                  className="px-3 py-1.5 rounded-lg text-xs dark:bg-claude-darkSurface bg-gray-100 dark:text-gray-400 text-gray-500 disabled:opacity-40 transition-colors hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover"
                >
                  {i18nService.t('skillsNextPage')}
                </button>
              </div>
            )}
          </>
        )
      )}

      {activeTab === 'packs' && (
        skillPacks.length === 0 ? (
          <div className="text-center py-12 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.currentLanguage === 'zh' ? '暂无技能包' : 'No skill packs available'}
          </div>
        ) : (
          <div className="space-y-6">
            {skillPacks.map((pack) => {
              const allInstalled = isPackAllInstalled(pack);
              const isInstalling = installingPack === pack.author;
              return (
                <div key={pack.author} className="rounded-xl border dark:border-claude-darkBorder border-claude-border overflow-hidden">
                  <div
                    className="flex items-center justify-between px-4 py-3 cursor-pointer dark:bg-claude-darkSurface/30 bg-claude-surface/30 hover:dark:bg-claude-darkSurface/50 hover:bg-claude-surface/50 transition-colors"
                    onClick={() => setCollapsedPacks(prev => {
                      const next = new Set(prev);
                      next.has(pack.author) ? next.delete(pack.author) : next.add(pack.author);
                      return next;
                    })}
                  >
                    <div className="flex items-center gap-2.5">
                      <svg className={`h-3.5 w-3.5 dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${collapsedPacks.has(pack.author) ? '' : 'rotate-90'}`} viewBox="0 0 20 20" fill="currentColor"><path fillRule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clipRule="evenodd" /></svg>
                      <span className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                        {pack.author}
                      </span>
                      <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-blue-500/15 text-blue-400">
                        {i18nService.t('skillPackSkillCount', { count: String(pack.count) })}
                      </span>
                      {pack.skills.some(s => s.is_official) && (
                        <span className="px-1.5 py-0.5 text-[9px] font-medium rounded bg-claude-accent/10 text-claude-accent">
                          {i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
                      {(() => {
                        const installedCount = pack.skills.filter(s => isSkillInstalled(s)).length;
                        if (allInstalled) {
                          return (
                            <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-green-600 dark:text-green-400 bg-green-500/10">
                              <CheckCircleIcon className="h-3.5 w-3.5" />
                              {i18nService.t('skillPackAllInstalled')}
                            </span>
                          );
                        }
                        const toInstallCount = pack.count - installedCount;
                        return (
                          <button
                            type="button"
                            onClick={() => handleInstallPack(pack)}
                            disabled={installingPack !== null}
                            className="inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                            {isInstalling && packInstallProgress
                              ? i18nService.t('skillInstallingPack', { current: String(packInstallProgress.current), total: String(packInstallProgress.total) })
                              : `${i18nService.t('skillInstallAll')}${installedCount > 0 ? ` (${toInstallCount})` : ''}`
                            }
                          </button>
                        );
                      })()}
                    </div>
                  </div>
                  {!collapsedPacks.has(pack.author) && (
                  <div className="grid grid-cols-2 gap-3 p-3">
                    {pack.skills.map((skill) => (
                      <div
                        key={skill.id}
                        className="rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-3 transition-colors hover:border-claude-accent/50 cursor-pointer"
                        onClick={() => setSelectedMarketplaceSkill(skill)}
                      >
                        <div className="flex items-start justify-between mb-2">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-7 h-7 rounded-lg dark:bg-claude-darkSurface bg-claude-surface flex items-center justify-center flex-shrink-0">
                              <PuzzleIcon className="h-4 w-4 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                            </div>
                            <span className="text-sm font-medium dark:text-claude-darkText text-claude-text truncate">
                              {skillService.getLocalizedSkillName(skill)}
                            </span>
                          </div>
                          <div className="flex-shrink-0">
                            {isSkillInstalled(skill) ? (
                              <span className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg text-green-600 dark:text-green-400 bg-green-500/10">
                                <CheckCircleIcon className="h-3.5 w-3.5" />
                                {i18nService.t('skillAlreadyInstalled')}
                              </span>
                            ) : (
                              <button
                                type="button"
                                onClick={(e) => { e.stopPropagation(); handleInstallMarketplaceSkill(skill); }}
                                disabled={installingSkillId !== null || installingPack !== null}
                                className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-medium rounded-lg bg-claude-accent text-white hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                              >
                                <ArrowDownTrayIcon className="h-3.5 w-3.5" />
                                {installingSkillId === skill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
                              </button>
                            )}
                          </div>
                        </div>
                        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary line-clamp-2 mb-2">
                          {resolveLocalizedText(skill.description)}
                        </p>
                        <div className="flex items-center gap-2 text-[10px] dark:text-claude-darkTextSecondary text-claude-textSecondary flex-wrap">
                          {skill.source?.author && (
                            <span className="px-1.5 py-0.5 rounded bg-gray-500/15 text-gray-400 font-medium">{skill.source.author}</span>
                          )}
                          {skill.version && (
                            <>
                              {skill.source?.author && <span>·</span>}
                              <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover font-medium">
                                v{skill.version}
                              </span>
                            </>
                          )}
                          {skill.source?.url?.includes('github.com') && (
                            <>
                              <span>·</span>
                              <span className="px-1.5 py-0.5 rounded bg-green-500/15 text-green-400 font-medium">{i18nService.currentLanguage === 'zh' ? '开源认证' : 'Open Source'}</span>
                            </>
                          )}
                          {skill.is_official && (
                            <>
                              <span>·</span>
                              <span className="px-1.5 py-0.5 rounded bg-claude-accent/10 text-claude-accent font-medium">{i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}</span>
                            </>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                  )}
                </div>
              );
            })}
          </div>
        )
      )}

      {selectedMarketplaceSkill && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg dark:bg-claude-darkBg bg-claude-bg flex items-center justify-center flex-shrink-0">
                  <PuzzleIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">
                    {skillService.getLocalizedSkillName(selectedMarketplaceSkill)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedMarketplaceSkill(null)}
                className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
              {resolveLocalizedText(selectedMarketplaceSkill.description)}
            </p>

            <div className="space-y-2 mb-5">
              {selectedMarketplaceSkill.version && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailVersion')}</span>
                  <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                    v{selectedMarketplaceSkill.version}
                  </span>
                </div>
              )}
              {(selectedMarketplaceSkill.source?.author || selectedMarketplaceSkill.source?.from) && (
                <div className="flex items-center text-xs">
                  <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailSource')}</span>
                  <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                    {selectedMarketplaceSkill.source.author || selectedMarketplaceSkill.source.from}
                  </span>
                </div>
              )}
              {selectedMarketplaceSkill.source?.url && (
                <div className="flex items-start text-xs">
                  <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary pt-0.5">URL</span>
                  <button
                    type="button"
                    className="text-claude-accent hover:underline break-all text-left"
                    onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(selectedMarketplaceSkill.source.url); }}
                  >
                    {selectedMarketplaceSkill.source.url}
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2 pt-1">
                {selectedMarketplaceSkill.source?.url?.includes('github.com') && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-500/15 text-green-400">{i18nService.currentLanguage === 'zh' ? '开源认证' : 'Open Source'}</span>
                )}
                {selectedMarketplaceSkill.is_official && (
                  <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-claude-accent/10 text-claude-accent">{i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}</span>
                )}
              </div>
            </div>

            {isSkillInstalled(selectedMarketplaceSkill) ? (
              <div className="flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-green-500/10 text-green-600 dark:text-green-400 text-sm font-medium">
                <CheckCircleIcon className="h-4 w-4" />
                {i18nService.t('skillAlreadyInstalled')}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => handleInstallMarketplaceSkill(selectedMarketplaceSkill)}
                disabled={installingSkillId !== null}
                className="w-full py-2.5 rounded-xl bg-claude-accent text-white text-sm font-medium hover:bg-claude-accent/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed flex items-center justify-center gap-1.5"
              >
                <ArrowDownTrayIcon className="h-4 w-4" />
                {installingSkillId === selectedMarketplaceSkill.id ? i18nService.t('skillInstalling') : i18nService.t('skillInstall')}
              </button>
            )}
          </div>
        </div>
      , document.body)}

      {selectedSkill && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between mb-4">
              <div className="flex items-center gap-3 min-w-0">
                <div className="w-9 h-9 rounded-lg dark:bg-claude-darkBg bg-claude-bg flex items-center justify-center flex-shrink-0">
                  <PuzzleIcon className="h-5 w-5 dark:text-claude-darkTextSecondary text-claude-textSecondary" />
                </div>
                <div className="min-w-0">
                  <div className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">
                    {getInstalledSkillName(selectedSkill)}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedSkill(null)}
                className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors flex-shrink-0"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary mb-4">
              {getInstalledSkillDescription(selectedSkill)}
            </p>

            <div className="space-y-2 mb-5">
              {(() => {
                const mp = findMarketplaceMatch(selectedSkill);
                return (
                  <>
                    {selectedSkill.version && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailVersion')}</span>
                        <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                          v{selectedSkill.version}
                        </span>
                      </div>
                    )}
                    {mp?.source?.author && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.currentLanguage === 'zh' ? '作者' : 'Author'}</span>
                        <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                          {mp.source.author}
                        </span>
                      </div>
                    )}
                    {mp?.source?.from && (
                      <div className="flex items-center text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('skillDetailSource')}</span>
                        <span className="px-1.5 py-0.5 rounded dark:bg-claude-darkSurfaceHover bg-claude-surfaceHover dark:text-claude-darkText text-claude-text font-medium">
                          {mp.source.from}
                        </span>
                      </div>
                    )}
                    {mp?.source?.url && (
                      <div className="flex items-start text-xs">
                        <span className="w-16 flex-shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary pt-0.5">URL</span>
                        <button
                          type="button"
                          className="text-claude-accent hover:underline break-all text-left"
                          onClick={(e) => { e.stopPropagation(); window.electron.shell.openExternal(mp.source.url); }}
                        >
                          {mp.source.url}
                        </button>
                      </div>
                    )}
                    <div className="flex items-center gap-2 pt-1">
                      {(mp?.source?.url?.includes('github.com')) && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-green-500/15 text-green-400">{i18nService.currentLanguage === 'zh' ? '开源认证' : 'Open Source'}</span>
                      )}
                      {(selectedSkill.isOfficial || mp?.is_official) && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-claude-accent/10 text-claude-accent">{i18nService.currentLanguage === 'zh' ? '官方认证' : 'Official'}</span>
                      )}
                      {selectedSkill.isBuiltIn && (
                        <span className="px-1.5 py-0.5 text-[10px] font-medium rounded bg-blue-500/10 text-blue-400">{i18nService.currentLanguage === 'zh' ? '内置' : 'Built-in'}</span>
                      )}
                    </div>
                  </>
                );
              })()}
            </div>

            <div className="flex items-center justify-between">
              {!selectedSkill.isBuiltIn ? (
                <button
                  type="button"
                  onClick={() => { setSelectedSkill(null); handleRequestDeleteSkill(selectedSkill); }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-sm rounded-xl text-red-500 dark:text-red-400 hover:bg-red-500/10 transition-colors"
                >
                  <TrashIcon className="h-4 w-4" />
                  {i18nService.t('deleteSkill')}
                </button>
              ) : (
                <div />
              )}
              <div
                className={`w-9 h-5 rounded-full flex items-center transition-colors cursor-pointer flex-shrink-0 ${
                  selectedSkill.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                }`}
                onClick={() => {
                  handleToggleSkill(selectedSkill.id);
                  setSelectedSkill({ ...selectedSkill, enabled: !selectedSkill.enabled });
                }}
              >
                <div
                  className={`w-3.5 h-3.5 rounded-full bg-white shadow-md transform transition-transform ${
                    selectedSkill.enabled ? 'translate-x-[18px]' : 'translate-x-[3px]'
                  }`}
                />
              </div>
            </div>
          </div>
        </div>
      , document.body)}

      {skillPendingDelete && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          
        >
          <div
            className="w-full max-w-sm mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-5"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
              {i18nService.t('deleteSkill')}
            </div>
            <p className="mt-2 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('skillDeleteConfirm').replace('{name}', getInstalledSkillName(skillPendingDelete))}
            </p>
            {skillActionError && (
              <div className="mt-3 text-xs text-red-500">
                {skillActionError}
              </div>
            )}
            <div className="mt-4 flex items-center justify-end gap-2">
              <button
                type="button"
                onClick={handleCancelDeleteSkill}
                disabled={isDeletingSkill}
                className="px-3 py-1.5 text-xs rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                type="button"
                onClick={handleConfirmDeleteSkill}
                disabled={isDeletingSkill}
                className="px-3 py-1.5 text-xs rounded-lg bg-red-500 text-white hover:bg-red-600 dark:bg-red-500 dark:hover:bg-red-400 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {i18nService.t('confirmDelete')}
              </button>
            </div>
          </div>
        </div>
      , document.body)}

      {isGithubImportOpen && createPortal(
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
          
        >
          <div
            className="w-full max-w-md mx-4 rounded-2xl dark:bg-claude-darkSurface bg-claude-surface border dark:border-claude-darkBorder border-claude-border shadow-2xl p-6"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="text-lg font-semibold dark:text-claude-darkText text-claude-text">
                  {i18nService.t('githubImportTitle')}
                </div>
                <p className="mt-1 text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                  {i18nService.t('githubImportDescription')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsGithubImportOpen(false)}
                className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                <XMarkIcon className="h-5 w-5" />
              </button>
            </div>

            <div className="mt-5 space-y-3">
              <div className="text-xs font-semibold tracking-wide dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('githubImportUrlLabel')}
              </div>
              <input
                ref={githubImportInputRef}
                type="text"
                value={skillDownloadSource}
                onChange={(e) => setSkillDownloadSource(e.target.value)}
                placeholder={i18nService.t('githubSkillPlaceholder')}
                className="w-full px-3 py-2.5 text-sm rounded-xl dark:bg-claude-darkBg bg-claude-bg dark:text-claude-darkText text-claude-text dark:placeholder-claude-darkTextSecondary placeholder-claude-textSecondary border dark:border-claude-darkBorder border-claude-border focus:outline-none focus:ring-2 focus:ring-claude-accent"
              />
              <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('githubImportExamples')}
              </p>
              {skillActionError && (
                <div className="text-xs text-red-500">
                  {skillActionError}
                </div>
              )}
              <button
                type="button"
                onClick={handleImportFromGithub}
                disabled={isDownloadingSkill || !skillDownloadSource.trim()}
                className="w-full py-2.5 rounded-xl bg-claude-accent text-white text-sm font-medium hover:bg-claude-accent/90 transition-colors disabled:opacity-50"
              >
                {isDownloadingSkill ? i18nService.t('importingSkill') : i18nService.t('importSkill')}
              </button>
            </div>
          </div>
        </div>
      , document.body)}
    </div>
  );
};

export default SkillsManager;
