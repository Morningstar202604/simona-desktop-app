import React, { useState, useEffect } from 'react';
import { ChevronRight, Smartphone, MonitorIcon, LogOut, MoreHorizontal, Check, X, User, Plus, Trash2, Edit2 } from 'lucide-react';
import { getUserProfile, updateUserProfile, getUserUsage, getGatewayUsage, getSessions, deleteSession, logoutOtherSessions, changePassword, deleteAccount, logout, getProviderModels, getPermissionConfig, setPermissionConfig } from '../api';
import ProviderSettings from './ProviderSettings';

interface SettingsPageProps {
  onClose: () => void;
}

const WORK_OPTIONS = [
  '', '软件工程', '产品管理', '数据科学',
  '市场营销', '设计', '研究', '教育', '金融',
  '法律', '医疗健康', '其他',
];

type Tab = 'general' | 'models' | 'account' | 'usage';

const SettingsPage = ({ onClose }: SettingsPageProps) => {
  const [tab, setTab] = useState<Tab>('models'); // Default to models tab (API card)
  const [profile, setProfile] = useState<any>(null);
  const [usage, setUsage] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState('');

  // Mode selection state
  const [selectedMode, setSelectedMode] = useState(() => {
    const saved = localStorage.getItem('api_mode');
    return saved || 'deepseek'; // Default to deepseek mode
  });

  // Form state
  const [fullName, setFullName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [workFunction, setWorkFunction] = useState('');
  const [personalPreferences, setPersonalPreferences] = useState('');
  const [theme, setTheme] = useState('dark');
  const [chatFont, setChatFont] = useState('default');
  const [defaultModel, setDefaultModel] = useState('simona-opus-4-6-thinking');
  const [sessions, setSessions] = useState<any[]>([]);
  const [currentSessionId, setCurrentSessionId] = useState('');
  const [pwdCurrent, setPwdCurrent] = useState('');
  const [pwdNew, setPwdNew] = useState('');
  const [pwdConfirm, setPwdConfirm] = useState('');
  const [pwdMsg, setPwdMsg] = useState('');
  const [pwdError, setPwdError] = useState('');
  const [pwdSaving, setPwdSaving] = useState(false);
  const [showPwdForm, setShowPwdForm] = useState(false);
  const [showDeleteAccount, setShowDeleteAccount] = useState(false);
  const [deletePassword, setDeletePassword] = useState('');
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; sessionId: string } | null>(null);
  // Floating widgets visibility state
  const [showWordCount, setShowWordCount] = useState(() => {
    const saved = localStorage.getItem('show_word_count');
    if (saved !== null) return saved === 'true';
    return typeof window !== 'undefined' && window.innerWidth >= 768; // 手机端默认隐藏
  });
  const [showTokenBar, setShowTokenBar] = useState(() => {
    const saved = localStorage.getItem('show_token_bar');
    if (saved !== null) return saved === 'true';
    return typeof window !== 'undefined' && window.innerWidth >= 768;
  });
  const [showSwarmButton] = useState(false);

  // 自动同意工具审批（默认关 → 弹窗询问）
  const [autoApprovePermission, setAutoApprovePermissionState] = useState<boolean>(() => {
    const saved = localStorage.getItem('auto_approve_permission');
    if (saved !== null) return saved === 'true';
    return false;
  });


  // Persona management state
  interface Persona {
    id: string;
    name: string;
    description: string;
    workFunction: string;
    personalPreferences: string;
    createdAt: number;
  }
  const [personas, setPersonas] = useState<Persona[]>([]);
  const [currentPersonaId, setCurrentPersonaId] = useState<string>('');
  const [showPersonaModal, setShowPersonaModal] = useState(false);
  const [editingPersona, setEditingPersona] = useState<Persona | null>(null);
  const [personaName, setPersonaName] = useState('');
  const [personaDesc, setPersonaDesc] = useState('');
  const [personaWork, setPersonaWork] = useState('');
  const [personaPrefs, setPersonaPrefs] = useState('');

  const isSelfHosted = localStorage.getItem('user_mode') === 'selfhosted';

  // 初始化时从后端同步自动审批设置
  useEffect(() => {
    getPermissionConfig().then(cfg => {
      setAutoApprovePermissionState(!!cfg.autoApprove);
      localStorage.setItem('auto_approve_permission', cfg.autoApprove ? 'true' : 'false');
    }).catch(() => {
      // 后端不可用，使用 localStorage 值
    });
  }, []);

  // Handle mode switch
  const handleModeSwitch = (mode: string) => {
    setSelectedMode(mode);
    localStorage.setItem('api_mode', mode);
    
    // Update user_mode based on selected mode
    if (mode === 'api') {
      localStorage.setItem('user_mode', 'selfhosted');
    } else {
      localStorage.removeItem('user_mode'); // Fixed mode
    }
    
    // Show success message
    setSaveMsg(`已切换到${mode === 'deepseek' ? 'DeepSeek' : mode === 'minimax' ? 'MiniMax' : 'API'}模式`);
    setTimeout(() => setSaveMsg(''), 2000);
  };

  useEffect(() => {
    // Load profile: self-hosted uses localStorage, Clawparrot uses backend
    if (isSelfHosted) {
      try {
        const saved = JSON.parse(localStorage.getItem('user_profile') || '{}');
        const user = JSON.parse(localStorage.getItem('user') || '{}');
        const p = { ...user, ...saved }; // saved overrides user defaults
        setProfile(p);
        setFullName(p.full_name || p.nickname || '');
        setDisplayName(p.display_name || p.nickname || '');
        setWorkFunction(p.work_function || '');
        setPersonalPreferences(p.personal_preferences || '');
      } catch { }
    } else {
      getUserProfile().then((data: any) => {
        const p = data?.user || data;
        setProfile(p);
        setFullName(p?.full_name || p?.nickname || '');
        setDisplayName(p?.display_name || p?.nickname || '');
        setWorkFunction(p?.work_function || '');
        setPersonalPreferences(p?.personal_preferences || '');
        setTheme(p?.theme || 'dark');
        setChatFont(p?.chat_font || 'default');
        setDefaultModel(p?.default_model || 'simona-opus-4-6-thinking');
      }).catch(() => { });
    }
    getUserUsage().then(setUsage).catch(() => { });
    getSessions().then(data => {
      setSessions(data.sessions || []);
      setCurrentSessionId(data.currentSessionId || '');
    }).catch(() => { });

    // Load personas from localStorage
    try {
      const savedPersonas = localStorage.getItem('personas');
      if (savedPersonas) {
        const parsed = JSON.parse(savedPersonas);
        setPersonas(parsed);
        const currentId = localStorage.getItem('current_persona_id');
        if (currentId && parsed.find((p: Persona) => p.id === currentId)) {
          setCurrentPersonaId(currentId);
          
          // Apply current persona to form fields
          const currentPersona = parsed.find((p: Persona) => p.id === currentId);
          if (currentPersona) {
            setWorkFunction(currentPersona.workFunction || '');
            setPersonalPreferences(currentPersona.personalPreferences || '');
            console.log('[SettingsPage] Applied current persona to form:', currentPersona.name);
          }
        }
      }
    } catch (e) {
      console.error('Failed to load personas:', e);
    }
  }, []);

  const handleSave = async (silent = false) => {
    if (!silent) {
      setSaving(true);
      setSaveMsg('');
    }
    try {
      const profileData = {
        full_name: fullName,
        display_name: displayName,
        work_function: workFunction,
        personal_preferences: personalPreferences,
        theme,
        chat_font: chatFont,
      };
      if (isSelfHosted) {
        // Self-hosted: persist to localStorage
        localStorage.setItem('user_profile', JSON.stringify(profileData));
        setProfile(profileData);
      } else {
        const data = await updateUserProfile(profileData);
        setProfile(data);
        const userStr = localStorage.getItem('user');
        if (userStr) {
          const user = JSON.parse(userStr);
          localStorage.setItem('user', JSON.stringify({ ...user, ...data }));
        }
      }
      window.dispatchEvent(new Event('userProfileUpdated'));
      if (!silent) {
        setSaveMsg('已保存');
        setTimeout(() => setSaveMsg(''), 2000);
      }
    } catch (err: any) {
      if (!silent) setSaveMsg(err.message || '保存失败');
    } finally {
      if (!silent) setSaving(false);
    }
  };

  // Persona management functions
  const savePersonas = (newPersonas: Persona[]) => {
    setPersonas(newPersonas);
    localStorage.setItem('personas', JSON.stringify(newPersonas));
  };

  const handleCreatePersona = () => {
    if (!personaName.trim()) return;
    
    const newPersona: Persona = {
      id: Date.now().toString(),
      name: personaName.trim(),
      description: personaDesc.trim(),
      workFunction: personaWork,
      personalPreferences: personaPrefs,
      createdAt: Date.now()
    };
    
    const updated = [newPersona, ...personas];
    savePersonas(updated);
    
    // If first persona, set as current
    if (!currentPersonaId) {
      setCurrentPersonaId(newPersona.id);
      localStorage.setItem('current_persona_id', newPersona.id);
    }
    
    closePersonaModal();
  };

  const handleUpdatePersona = () => {
    if (!editingPersona || !personaName.trim()) return;
    
    const updated = personas.map(p => 
      p.id === editingPersona.id ? {
        ...p,
        name: personaName.trim(),
        description: personaDesc.trim(),
        workFunction: personaWork,
        personalPreferences: personaPrefs
      } : p
    );
    
    savePersonas(updated);
    closePersonaModal();
  };

  const handleDeletePersona = (id: string) => {
    if (confirm('确定要删除这个人设吗?')) {
      const updated = personas.filter(p => p.id !== id);
      savePersonas(updated);
      
      // If deleted persona was current, clear current AND clean up user_profile
      if (currentPersonaId === id) {
        setCurrentPersonaId('');
        localStorage.removeItem('current_persona_id');
        
        // Remove the deleted persona's data from user_profile
        try {
          const profile = JSON.parse(localStorage.getItem('user_profile') || '{}');
          delete profile.work_function;
          delete profile.personal_preferences;
          localStorage.setItem('user_profile', JSON.stringify(profile));
          
          // Also clean up 'user' key
          const userData = JSON.parse(localStorage.getItem('user') || '{}');
          if (Object.keys(userData).length > 0) {
            delete userData.work_function;
            delete userData.personal_preferences;
            localStorage.setItem('user', JSON.stringify(userData));
          }
          console.log('[Persona] Deleted persona, cleaned up user_profile');
        } catch (err) {
          console.error('[Persona] Failed to cleanup profile:', err);
        }
      }
    }
  };

  const handleSwitchPersona = (id: string) => {
    setCurrentPersonaId(id);
    localStorage.setItem('current_persona_id', id);
    
    // Apply persona settings to current profile
    const persona = personas.find(p => p.id === id);
    if (persona) {
      setWorkFunction(persona.workFunction);
      setPersonalPreferences(persona.personalPreferences);
      // Auto-save
      setTimeout(() => handleSave(true), 100);
    }
  };

  const openCreateModal = () => {
    console.log('[Persona] Opening create modal');
    setEditingPersona(null);
    setPersonaName('');
    setPersonaDesc('');
    setPersonaWork(workFunction);
    setPersonaPrefs(personalPreferences);
    setShowPersonaModal(true);
    console.log('[Persona] Modal state:', showPersonaModal);
  };

  const openEditModal = (persona: Persona) => {
    setEditingPersona(persona);
    setPersonaName(persona.name);
    setPersonaDesc(persona.description);
    setPersonaWork(persona.workFunction);
    setPersonaPrefs(persona.personalPreferences);
    setShowPersonaModal(true);
  };

  const closePersonaModal = () => {
    setShowPersonaModal(false);
    setEditingPersona(null);
    setPersonaName('');
    setPersonaDesc('');
    setPersonaWork('');
    setPersonaPrefs('');
  };

  // Auto-save on blur or selection
  const handleAutoSave = () => {
    // Optional: implement auto-save debounce if needed, currently manual save button is also fine
    // The screenshot shows a clean interface, maybe we can auto-save
    // But for now, let's keep the explicit save button as it's safer for "no new function" logic, 
    // or just match the UI. Official Simona settings mostly auto-save or have small confirms.
    // I'll keep the Save button for Profile but make Theme instant.
  };

  const applyTheme = (t: string) => {
    setTheme(t);
    const root = document.documentElement;
    if (t === 'dark') {
      root.setAttribute('data-theme', 'dark');
      root.classList.add('dark');
    } else if (t === 'auto') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
      root.classList.toggle('dark', prefersDark);
    } else {
      root.setAttribute('data-theme', 'light');
      root.classList.remove('dark');
    }
    localStorage.setItem('theme', t);
    // Auto-save theme
    updateUserProfile({ theme: t }).catch(() => { });
  };

  const applyFont = (f: string) => {
    setChatFont(f);
    document.documentElement.setAttribute('data-chat-font', f);
    localStorage.setItem('chat_font', f);
    updateUserProfile({ chat_font: f }).catch(() => { });
  };

  const HARDCODED_MODELS = [
    { base: 'simona-opus-4-6', label: 'Opus 4.6' },
    { base: 'simona-sonnet-4-6', label: 'Sonnet 4.6' },
    { base: 'simona-haiku-4-5-20251001', label: 'Haiku 4.5' },
  ];
  const [providerModels, setProviderModels] = useState<Array<{ base: string; label: string }>>([]);

  useEffect(() => {
    if (isSelfHosted) {
      getProviderModels().then(models => {
        setProviderModels(models.map(m => ({ base: m.id, label: m.name || m.id })));
      }).catch(() => { });
    }
  }, [isSelfHosted]);

  const MODEL_BASES = isSelfHosted && providerModels.length > 0 ? providerModels : HARDCODED_MODELS;

  const defaultModelIsThinking = defaultModel.endsWith('-thinking');
  const defaultModelBase = defaultModel.replace(/-thinking$/, '');

  const applyDefaultModel = (base: string, thinking: boolean) => {
    const m = thinking ? `${base}-thinking` : base;
    setDefaultModel(m);
    localStorage.setItem('default_model', m);
    import('../utils/modelSettingsSync').then(mod => mod.saveSettingsToServer());
    updateUserProfile({ default_model: m }).catch(() => { });
  };

  const initials = (fullName || profile?.nickname || 'U').charAt(0).toUpperCase();

  // Inject Google Fonts
  useEffect(() => {
    const link = document.createElement('link');
    link.href = 'https://fonts.googleapis.com/css2?family=Crimson+Text:ital,wght@0,400;0,600;0,700;1,400&family=DM+Serif+Display&family=EB+Garamond:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,300;9..144,400;9..144,500;9..144,600;9..144,700&family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Lora:ital,wght@0,400;0,500;0,600;0,700;1,400&family=Merriweather:ital,wght@0,300;0,400;0,700;0,900;1,300&family=Noto+Serif:ital,wght@0,400;0,700;1,400&family=Playfair+Display:ital,wght@0,400;0,500;0,600;0,700;0,800;0,900;1,400&family=Spectral:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,300&display=swap';
    link.rel = 'stylesheet';
    document.head.appendChild(link);
    return () => {
      document.head.removeChild(link);
    };
  }, []);

  // Font selector options
  return (
    <>
    <style>{`
@media (max-width: 767px) {
  .settings-mobile-col {
    flex-direction: column !important;
  }
  .settings-mobile-hide {
    display: none !important;
  }
  .settings-mobile-tabs {
    width: 100% !important;
    flex-direction: row !important;
    padding: 8px 12px !important;
    overflow-x: auto !important;
    gap: 6px !important;
    flex-shrink: 0 !important;
    white-space: nowrap !important;
  }
  .settings-mobile-tabs button {
    flex-shrink: 0 !important;
  }
  .settings-mobile-content {
    padding: 12px !important;
    max-width: 100% !important;
  }
  .settings-mobile-grid-3 {
    grid-template-columns: 1fr !important;
  }
  .settings-mobile-grid-2 {
    grid-template-columns: 1fr !important;
  }
}
`}</style>
    <div className="flex-1 flex h-full overflow-hidden bg-simona-bg text-simona-text settings-mobile-col">
      {/* Mode Selection Cards - HIDDEN */}
      {/* 
      <div className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50">
        ...
      </div>
      */}

      {/* Left Sidebar Navigation */}
      <div className="w-[200px] flex-shrink-0 pt-16 pl-8 flex flex-col gap-1 settings-mobile-tabs">
        <h2
          className="font-[Spectral] text-[28px] text-simona-text px-3 mb-6 settings-mobile-hide"
          style={{
            fontWeight: 500,
            WebkitTextStroke: '0.5px currentColor'
          }}
        >
          设置
        </h2>

        <button
          onClick={() => setTab('general')}
          className={`text-left px-3 py-2 rounded-lg text-[15px] font-medium transition-colors ${tab === 'general' ? 'bg-simona-btn-hover text-simona-text' : 'text-simona-textSecondary hover:bg-simona-hover'
            }`}
        >
          通用
        </button>
        {localStorage.getItem('user_mode') === 'selfhosted' && (
          <button
            onClick={() => setTab('models')}
            className={`text-left px-3 py-2 rounded-lg text-[15px] font-medium transition-colors ${tab === 'models' ? 'bg-simona-btn-hover text-simona-text' : 'text-simona-textSecondary hover:bg-simona-hover'
              }`}
          >
            模型
          </button>
        )}
        {/* Always show Usage tab */}
      </div>

      {/* Right Content Area */}
      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="max-w-6xl pt-16 pl-12 pb-32 pr-12 settings-mobile-content">
          {tab === 'general' && renderGeneral()}
          {tab === 'models' && <ProviderSettings />}
          {tab === 'usage' && renderUsage()}
        </div>
      </div>

      {/* Persona Modal - Moved outside tabs so it works on all tabs */}
      {showPersonaModal && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in"
          onClick={closePersonaModal}>
          <div className="bg-white dark:bg-[#2B2A29] p-6 rounded-2xl w-full max-w-md shadow-xl border border-simona-border animate-in zoom-in-95 duration-200"
            onClick={e => e.stopPropagation()}>
            <h4 className="text-[18px] font-semibold text-simona-text mb-4">
              {editingPersona ? '编辑人设' : '新建人设'}
            </h4>
            
            <div className="space-y-4">
              <div>
                <label className="block text-[13px] font-medium text-simona-textSecondary mb-1.5">人设名称 *</label>
                <input
                  type="text"
                  value={personaName}
                  onChange={e => setPersonaName(e.target.value)}
                  placeholder="例如：编程助手、写作专家"
                  className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#5B9BFF] focus:ring-1 focus:ring-[#5B9BFF]"
                  autoFocus
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium text-simona-textSecondary mb-1.5">描述</label>
                <input
                  type="text"
                  value={personaDesc}
                  onChange={e => setPersonaDesc(e.target.value)}
                  placeholder="简短描述这个人设的用途"
                  className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#5B9BFF] focus:ring-1 focus:ring-[#5B9BFF]"
                />
              </div>

              <div>
                <label className="block text-[13px] font-medium text-simona-textSecondary mb-1.5">职业</label>
                <div className="relative">
                  <select
                    value={personaWork}
                    onChange={e => setPersonaWork(e.target.value)}
                    className="w-full px-3 py-2.5 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#5B9BFF] focus:ring-1 focus:ring-[#5B9BFF] appearance-none cursor-pointer"
                  >
                    <option value="">选择职业</option>
                    {WORK_OPTIONS.filter(Boolean).map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                  <ChevronRight size={16} className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-simona-textSecondary pointer-events-none" />
                </div>
              </div>

              <div>
                <label className="block text-[13px] font-medium text-simona-textSecondary mb-1.5">个人偏好</label>
                <textarea
                  value={personaPrefs}
                  onChange={e => setPersonaPrefs(e.target.value)}
                  rows={3}
                  placeholder="例如：回答尽量简洁，使用中文，代码注释用英文"
                  className="w-full px-3 py-2.5 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#5B9BFF] focus:ring-1 focus:ring-[#5B9BFF] resize-none"
                />
              </div>
            </div>

            <div className="flex gap-3 pt-5 justify-end">
              <button onClick={closePersonaModal}
                className="px-4 py-2 text-simona-textSecondary hover:bg-simona-hover rounded-lg text-[14px] font-medium transition-colors">
                取消
              </button>
              <button onClick={editingPersona ? handleUpdatePersona : handleCreatePersona}
                disabled={!personaName.trim()}
                className="px-4 py-2 bg-[#5B9BFF] hover:bg-[#4A8AE6] text-white text-[14px] font-medium rounded-lg transition-colors disabled:opacity-60 disabled:cursor-not-allowed">
                {editingPersona ? '保存' : '创建'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
    </>
  );

  function renderAccount() {
    const handleChangePassword = async () => {
      setPwdError(''); setPwdMsg('');
      if (!pwdCurrent || !pwdNew || !pwdConfirm) { setPwdError('请填写所有字段'); return; }
      if (pwdNew.length < 6) { setPwdError('新密码至少 6 位'); return; }
      if (pwdNew !== pwdConfirm) { setPwdError('两次输入的新密码不一致'); return; }
      setPwdSaving(true);
      try {
        await changePassword(pwdCurrent, pwdNew);
        setPwdMsg('密码修改成功，其他设备已自动登出');
        setPwdCurrent(''); setPwdNew(''); setPwdConfirm('');
        setShowPwdForm(false);
        getSessions().then(data => { setSessions(data.sessions || []); setCurrentSessionId(data.currentSessionId || ''); }).catch(() => { });
      } catch (e: any) { setPwdError(e.message || '修改失败'); }
      finally { setPwdSaving(false); }
    };

    const handleDeleteSession = async (id: string) => {
      try {
        await deleteSession(id);
        setSessions(prev => prev.filter(s => s.id !== id));
      } catch (e: any) { alert(e.message || '操作失败'); }
    };

    const handleLogoutOthers = async () => {
      if (!confirm('确定登出所有其他设备？')) return;
      try {
        await logoutOtherSessions();
        setSessions(prev => prev.filter(s => s.id === currentSessionId));
      } catch (e: any) { alert(e.message || '操作失败'); }
    };

    const formatTime = (t: string) => {
      if (!t) return '';
      let timeStr = t;
      // Handle SQLite format (space instead of T)
      if (timeStr.includes(' ') && !timeStr.includes('T')) {
        timeStr = timeStr.replace(' ', 'T');
      }
      // Handle missing timezone (assume UTC if no Z or offset at end)
      // Regex checks for Z or +HH:MM or -HH:MM or +HHMM or -HHMM at the end
      if (!/Z$|[+-]\d{2}:?\d{2}$/.test(timeStr)) {
        timeStr += 'Z';
      }

      const d = new Date(timeStr);
      if (isNaN(d.getTime())) return 'Invalid Date';

      return d.toLocaleString('en-US', {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
        hour12: true
      });
    };

    return (
      <div className="space-y-10 animate-fade-in">
        {/* 邮箱 */}
        <section>
          <h3 className="text-[16px] font-semibold text-simona-text mb-5">账号</h3>
          <div className="space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <label className="block text-[13px] font-medium text-simona-textSecondary mb-1.5">邮箱地址</label>
                <div className="text-[14px] text-simona-text">{profile?.email || '-'}</div>
              </div>
              <div className="flex items-center gap-4 mt-4">
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); setShowPwdForm(true); setPwdError(''); setPwdMsg(''); }}
                  className="text-[13px] text-simona-textSecondary hover:text-simona-text hover:underline transition-colors"
                >
                  修改密码
                </button>
                <div className="w-[1px] h-3 bg-simona-border"></div>
                <button
                  type="button"
                  onClick={(e) => { e.preventDefault(); setShowDeleteAccount(true); setDeleteError(''); setDeletePassword(''); }}
                  className="text-[13px] text-[#B9382C] hover:text-[#a02e23] hover:underline transition-colors"
                >
                  注销账号
                </button>
              </div>
            </div>
          </div>
          {/* Change Password Modal */}
          {showPwdForm && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in"
              onClick={() => { setShowPwdForm(false); setPwdError(''); setPwdCurrent(''); setPwdNew(''); setPwdConfirm(''); }}>
              <div className="bg-white dark:bg-[#2B2A29] p-6 rounded-2xl w-full max-w-sm shadow-xl border border-simona-border animate-in zoom-in-95 duration-200"
                onClick={e => e.stopPropagation()}>
                <h4 className="text-[18px] font-semibold text-simona-text mb-4">修改密码</h4>
                {pwdMsg && <div className="p-2 mb-3 bg-green-50 text-green-700 text-[13px] rounded-lg">{pwdMsg}</div>}
                {pwdError && <div className="p-2 mb-3 bg-red-50 text-red-600 text-[13px] rounded-lg">{pwdError}</div>}
                <div className="space-y-3">
                  <input type="password" value={pwdCurrent} onChange={e => setPwdCurrent(e.target.value)}
                    placeholder="当前密码" className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#387ee0] focus:ring-0" />
                  <input type="password" value={pwdNew} onChange={e => setPwdNew(e.target.value)}
                    placeholder="新密码（至少 6 位）" className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#387ee0] focus:ring-0" />
                  <input type="password" value={pwdConfirm} onChange={e => setPwdConfirm(e.target.value)}
                    placeholder="确认新密码" className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#387ee0] focus:ring-0" />
                </div>
                <div className="flex gap-3 pt-5 justify-end">
                  <button onClick={(e) => { e.preventDefault(); setShowPwdForm(false); setPwdError(''); setPwdCurrent(''); setPwdNew(''); setPwdConfirm(''); }}
                    className="px-4 py-2 text-simona-textSecondary hover:bg-simona-hover rounded-lg text-[14px] font-medium transition-colors">
                    取消
                  </button>
                  <button onClick={(e) => { e.preventDefault(); handleChangePassword(); }} disabled={pwdSaving}
                    className="px-4 py-2 bg-simona-btn-hover text-white text-[14px] font-medium rounded-lg transition-colors disabled:opacity-60">
                    {pwdSaving ? '保存中...' : '更新密码'}
                  </button>
                </div>
              </div>
            </div>
          )}

          {/* Delete Account Modal */}
          {showDeleteAccount && (
            <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm animate-fade-in"
              onClick={() => { setShowDeleteAccount(false); setDeleteError(''); setDeletePassword(''); }}>
              <div className="bg-white dark:bg-[#2B2A29] p-6 rounded-2xl w-full max-w-sm shadow-xl border border-red-200 dark:border-red-900/30 animate-in zoom-in-95 duration-200"
                onClick={e => e.stopPropagation()}>
                <h4 className="text-[18px] font-semibold text-[#B9382C] mb-2">注销账号</h4>
                <p className="text-[14px] text-simona-textSecondary mb-4">
                  此操作不可撤销。您的所有数据将被永久删除。
                </p>
                {deleteError && <div className="p-2 mb-3 bg-red-50 text-red-600 text-[13px] rounded-lg">{deleteError}</div>}
                <input type="password" value={deletePassword} onChange={e => setDeletePassword(e.target.value)}
                  placeholder="输入密码以确认"
                  className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#B9382C] focus:ring-1 focus:ring-[#B9382C]" />
                <div className="flex gap-3 pt-5 justify-end">
                  <button onClick={(e) => { e.preventDefault(); setShowDeleteAccount(false); setDeleteError(''); setDeletePassword(''); }}
                    className="px-4 py-2 text-simona-textSecondary hover:bg-simona-hover rounded-lg text-[14px] font-medium transition-colors">
                    取消
                  </button>
                  <button onClick={async (e) => {
                    e.preventDefault();
                    if (!deletePassword) { setDeleteError('请输入密码'); return; }
                    setDeleting(true); setDeleteError('');
                    try {
                      await deleteAccount(deletePassword);
                      logout();
                    } catch (e: any) { setDeleteError(e.message || '注销失败'); }
                    finally { setDeleting(false); }
                  }} disabled={deleting}
                    className="px-4 py-2 bg-[#B9382C] hover:bg-[#a02e23] text-white text-[14px] font-medium rounded-lg transition-colors disabled:opacity-60">
                    {deleting ? '注销中...' : '确认注销'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </section>

        <hr className="border-simona-border" />

        {/* 活跃会话 */}
        <section>
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-[16px] font-semibold text-simona-text">活跃会话</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-simona-border text-[13px] font-medium text-simona-textSecondary">
                  <th className="py-2 pb-3 font-medium">设备</th>
                  <th className="py-2 pb-3 font-medium">地址</th>
                  <th className="py-2 pb-3 font-medium">创建时间</th>
                  <th className="py-2 pb-3 font-medium">最近活跃</th>
                  <th className="py-2 pb-3 font-medium"></th>
                </tr>
              </thead>
              <tbody className="text-[14px] text-simona-text">
                {sessions.map(s => (
                  <tr key={s.id} className="border-b border-simona-border last:border-0 group">
                    <td className="py-3 pr-4 align-middle">
                      <div className="flex items-center gap-2">
                        <span className="text-simona-textSecondary flex-shrink-0">
                          {s.device?.includes('Android') || s.device?.includes('iOS') ? <Smartphone size={16} /> : <MonitorIcon size={16} />}
                        </span>
                        <span className="font-medium">{s.device || 'Unknown Device'}</span>
                        {s.id === currentSessionId && (
                          <span className="ml-1 text-[11px] px-1.5 py-0.5 rounded-sm bg-neutral-200 dark:bg-neutral-700 text-simona-textSecondary">Current</span>
                        )}
                      </div>
                    </td>
                    <td className="py-3 pr-4 align-middle text-simona-textSecondary">
                      {s.location || 'Unknown Location'}
                    </td>
                    <td className="py-3 pr-4 align-middle text-simona-textSecondary whitespace-nowrap">
                      {formatTime(s.created_at || '')}
                    </td>
                    <td className="py-3 pr-4 align-middle text-simona-textSecondary whitespace-nowrap">
                      {formatTime(s.last_active || '')}
                    </td>
                    <td className="py-3 align-middle text-right">
                      {s.id !== currentSessionId && (
                        <div className="relative">
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const rect = e.currentTarget.getBoundingClientRect();
                              setCtxMenu({ x: rect.right, y: rect.bottom, sessionId: s.id });
                            }}
                            className="p-1 rounded text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover transition-colors"
                          >
                            <MoreHorizontal size={16} />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sessions.length === 0 && (
              <div className="text-[13px] text-simona-textSecondary py-4 text-center">No active sessions</div>
            )}
          </div>

          {/* Right-click context menu */}
          {ctxMenu && (
            <>
              <div className="fixed inset-0 z-50" onClick={() => setCtxMenu(null)} onContextMenu={e => { e.preventDefault(); setCtxMenu(null); }} />
              <div
                className="fixed z-50 bg-white dark:bg-[#2B2A29] border border-[#E0DFDC] dark:border-[#3C3C3C] rounded-lg shadow-lg py-1 min-w-[120px] animate-in fade-in zoom-in-95 duration-100"
                style={{
                  left: ctxMenu.x - 120, // Align right edge with button
                  top: ctxMenu.y + 4     // Slightly below button
                }}>
                <button onClick={() => { handleDeleteSession(ctxMenu.sessionId); setCtxMenu(null); }}
                  className="w-full text-left px-4 py-2 text-[13px] text-simona-text hover:bg-[#F5F4F1] dark:hover:bg-[#383838] transition-colors">
                  Log out
                </button>
              </div>
            </>
          )}
        </section>
      </div>
    );
  }

  function renderGeneral() {
    return (
      <div className="space-y-10 animate-fade-in">
        {/* 外观 + 聊天字体 + 悬浮组件 — 同一行 */}
        <div className="grid grid-cols-3 gap-6 settings-mobile-grid-3">
          {/* Appearance/Theme */}
          <section>
            <h3 className="text-[16px] font-semibold text-simona-text mb-5">外观</h3>
            <div className="relative">
              <select
                value={theme}
                onChange={(e) => applyTheme(e.target.value)}
                className="w-full px-3 py-2.5 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#5B9BFF] focus:ring-1 focus:ring-[#5B9BFF] appearance-none cursor-pointer"
              >
                <option value="light">浅色模式</option>
                <option value="dark">深色模式</option>
                <option value="auto">跟随系统</option>
              </select>
              <ChevronRight size={16} className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-simona-textSecondary pointer-events-none" />
            </div>
          </section>

          {/* Chat Font */}
          <section>
            <h3 className="text-[16px] font-semibold text-simona-text mb-5">聊天字体</h3>
            <div className="relative">
              <select
                value={chatFont}
                onChange={(e) => applyFont(e.target.value)}
                className="w-full px-3 py-2.5 bg-simona-input border border-simona-border rounded-lg text-[14px] text-simona-text focus:outline-none focus:border-[#5B9BFF] focus:ring-1 focus:ring-[#5B9BFF] appearance-none cursor-pointer"
              >
                <option value="default">默认（宋体风格）</option>
                <option value="sans">无衬线（现代简洁）</option>
                <option value="system">系统默认</option>
                <option value="chinese">中国风（思源宋体）</option>
                <option value="dyslexic">易读模式</option>
              </select>
              <ChevronRight size={16} className="absolute right-3 top-1/2 -translate-y-1/2 rotate-90 text-simona-textSecondary pointer-events-none" />
            </div>
          </section>

          {/* Floating Widgets */}
          <section>
            <h3 className="text-[16px] font-semibold text-simona-text mb-5">悬浮组件</h3>
            {/* 字数限制已隐藏 */}
            <div className="flex items-center justify-between p-4 bg-simona-input border border-simona-border rounded-lg h-[42px] mt-2">
              <div className="flex items-center gap-2">
                <span className="text-[14px] font-medium text-simona-text">上下文进度条</span>
                <span className="text-[12px] text-simona-textSecondary">输入框旁 token 读条</span>
              </div>
              <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
                <input
                  type="checkbox"
                  checked={showTokenBar}
                  onChange={(e) => {
                    const val = e.target.checked;
                    setShowTokenBar(val);
                    localStorage.setItem('show_token_bar', val.toString());
                    window.dispatchEvent(new CustomEvent('floating-widgets-changed'));
                  }}
                  className="sr-only peer"
                />
                <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-[#387ee0]/20 dark:bg-gray-700 rounded-full peer dark:peer-checked:bg-[#387ee0] peer-checked:bg-[#387ee0] peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600"></div>
              </label>
            </div>
            {/* 蜂群按钮已隐藏 */}
          </section>
        </div>

        {/* 工具审批 */}
        <section>
          <h3 className="text-[16px] font-semibold text-simona-text mb-5">工具审批</h3>
          <div className="flex items-center justify-between p-4 bg-simona-input border border-simona-border rounded-lg">
            <div className="flex flex-col gap-0.5">
              <span className="text-[14px] font-medium text-simona-text">自动同意工具执行</span>
              <span className="text-[12px] text-simona-textSecondary">开启后，Bash、文件写入等工具将自动执行，不再弹窗询问</span>
            </div>
            <label className="relative inline-flex items-center cursor-pointer flex-shrink-0">
              <input
                type="checkbox"
                checked={autoApprovePermission}
                onChange={async (e) => {
                  const val = e.target.checked;
                  setAutoApprovePermissionState(val);
                  localStorage.setItem('auto_approve_permission', val.toString());
                  try { await setPermissionConfig(val); }
                  catch (err) { console.error('Failed to sync auto-approve setting:', err); }
                }}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-[#387ee0]/20 dark:bg-gray-700 rounded-full peer dark:peer-checked:bg-[#387ee0] peer-checked:bg-[#387ee0] peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all dark:border-gray-600"></div>
            </label>
          </div>
        </section>

        {/* Persona Management Section */}
        <section>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-[16px] font-semibold text-simona-text">人设管理</h3>
            <button
              onClick={(e) => {
                console.log('[Persona] Button clicked!');
                e.preventDefault();
                e.stopPropagation();
                openCreateModal();
              }}
              className="px-3 py-1.5 text-[13px] font-medium bg-[#5B9BFF] hover:bg-[#4A8AE6] text-white rounded-lg transition-colors flex items-center gap-1.5 cursor-pointer"
              style={{ zIndex: 100 }}
            >
              <Plus size={14} />
              新建人设
            </button>
          </div>

          {personas.length === 0 ? (
            <div className="p-8 text-center border-2 border-dashed border-simona-border rounded-xl">
              <User size={32} className="mx-auto mb-3 text-simona-textSecondary opacity-30" />
              <p className="text-[14px] text-simona-textSecondary mb-2">暂无人设</p>
              <p className="text-[12px] text-simona-textSecondary/60">创建多个人设，快速切换不同场景</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 settings-mobile-grid-2">
              {personas.map(persona => (
                <div
                  key={persona.id}
                  onClick={() => handleSwitchPersona(persona.id)}
                  className={`relative p-4 border-2 rounded-xl cursor-pointer transition-all group ${
                    currentPersonaId === persona.id
                      ? 'border-[#5B9BFF] bg-[#5B9BFF]/5'
                      : 'border-simona-border hover:border-[#5B9BFF]/50 hover:bg-simona-hover'
                  }`}
                >
                  {currentPersonaId === persona.id && (
                    <div className="absolute top-2 right-2">
                      <Check size={16} className="text-[#5B9BFF]" />
                    </div>
                  )}
                  
                  <div className="flex items-start justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div className={`w-8 h-8 rounded-full flex items-center justify-center text-white text-sm font-medium ${
                        currentPersonaId === persona.id ? 'bg-[#5B9BFF]' : 'bg-simona-textSecondary'
                      }`}>
                        {persona.name.charAt(0).toUpperCase()}
                      </div>
                      <div>
                        <h4 className="text-[14px] font-semibold text-simona-text">{persona.name}</h4>
                        {persona.description && (
                          <p className="text-[11px] text-simona-textSecondary line-clamp-1">{persona.description}</p>
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 mt-3 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        openEditModal(persona);
                      }}
                      className="p-1.5 hover:bg-simona-hover rounded text-simona-textSecondary hover:text-blue-500 transition-colors"
                      title="编辑"
                    >
                      <Edit2 size={14} />
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeletePersona(persona.id);
                      }}
                      className="p-1.5 hover:bg-red-50 rounded text-simona-textSecondary hover:text-red-500 transition-colors"
                      title="删除"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        <hr className="border-simona-border" />



        {/* Default Model Section — only for Clawparrot (self-hosted configures in Models tab) */}
        {localStorage.getItem('user_mode') !== 'selfhosted' && <><hr className="border-simona-border" /><section>
          <h3 className="text-[16px] font-semibold text-simona-text mb-5">默认模型</h3>
          <div className="space-y-5">
            <div>
              <label className="block text-[13px] font-medium text-simona-textSecondary mb-1.5">新对话默认使用的模型</label>
              <div className="relative">
                <select
                  value={defaultModelBase}
                  onChange={e => applyDefaultModel(e.target.value, defaultModelIsThinking)}
                  className="w-full px-3 py-2 bg-simona-input border border-simona-border rounded-md text-[14px] text-simona-text focus:outline-none focus:border-[#387ee0] focus:ring-0 appearance-none transition-all"
                >
                  {MODEL_BASES.map(m => (
                    <option key={m.base} value={m.base}>{m.label}</option>
                  ))}
                </select>
                <div className="absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none text-simona-textSecondary">
                  <svg width="10" height="6" viewBox="0 0 10 6" fill="none" xmlns="http://www.w3.org/2000/svg">
                    <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <div className="text-[13px] font-medium text-simona-textSecondary">扩展思考</div>
                <div className="text-[12px] text-simona-textSecondary mt-0.5">让模型在回答前进行深度思考</div>
              </div>
              <button
                onClick={() => applyDefaultModel(defaultModelBase, !defaultModelIsThinking)}
                className={`w-10 h-6 rounded-full relative transition-colors duration-200 ${defaultModelIsThinking ? 'bg-blue-600' : 'bg-[#E5E5E5]'}`}
              >
                <div className={`absolute top-1 w-4 h-4 rounded-full bg-white shadow-sm transition-transform duration-200 ${defaultModelIsThinking ? 'left-5' : 'left-1'}`} />
              </button>
            </div>
          </div>
        </section></>}

      </div>
    );
  }

  function renderUsage() {
    if (!usage) {
      return <div className="text-[14px] text-[#999] py-8">Loading usage data...</div>;
    }

    const tokenQuota = Number(usage.token_quota) || 0;
    const tokenUsed = Number(usage.token_used) || 0;
    const tokenRemaining = Number(usage.token_remaining) || 0;
    const usagePercent = Number(usage.usage_percent) || 0;
    const storageQuota = Number(usage.storage_quota) || 0;
    const storageUsed = Number(usage.storage_used) || 0;
    const storagePercent = Number(usage.storage_percent) || 0;
    const plan = usage.plan;
    const messages = usage.messages;
    const quota = usage.quota;

    // Calculate actual cost based on token usage and model pricing
    const calculateCost = () => {
      try {
        const totalTokens = tokenUsed || 0;
        
        // Assume average pricing (mix of DeepSeek V4 Pro and Flash)
        // Average input price: ~¥1.5/million tokens (weighted average)
        // Average output price: ~¥4/million tokens
        // Assuming 70% input, 30% output ratio
        const inputTokens = totalTokens * 0.7;
        const outputTokens = totalTokens * 0.3;
        
        const inputCost = (inputTokens / 1000000) * 1.5;
        const outputCost = (outputTokens / 1000000) * 4;
        
        return inputCost + outputCost;
      } catch {
        return 0;
      }
    };

    const estimatedCost = calculateCost();
    
    console.log('[Usage] tokenUsed:', tokenUsed, '| estimatedCost:', estimatedCost, '| messages:', messages);

    const formatDollar = (n: number) => {
      return `$${n.toFixed(2)}`;
    };

    const formatBytes = (n: number) => {
      if (n >= 1073741824) return `${(n / 1073741824).toFixed(1)} GB`;
      if (n >= 1048576) return `${(n / 1048576).toFixed(1)} MB`;
      if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
      return `${n} B`;
    };

    const daysRemaining = plan?.expires_at
      ? Math.max(0, Math.ceil((new Date(plan.expires_at).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))
      : 0;

    const formatTimeLeft = (isoStr: string | null) => {
      if (!isoStr) return '';
      const diff = new Date(isoStr).getTime() - Date.now();
      if (diff <= 0) return '即将重置';
      const hours = Math.floor(diff / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);
      if (hours > 0) return `${hours}小时${mins}分钟后重置`;
      return `${mins}分钟后重置`;
    };

    const formatResetDate = (isoStr: string | null) => {
      if (!isoStr) return '';
      const d = new Date(isoStr);
      const diff = d.getTime() - Date.now();
      if (diff <= 0) return '即将重置';
      return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')} 重置`;
    };

    const renderLimitItem = (title: string, used: number, limit: number, subtitle: string) => {
      const pct = limit > 0 ? Math.min((used / limit) * 100, 100) : 0;
      const isLow = pct < 50;
      const isMedium = pct >= 50 && pct < 80;
      const isHigh = pct >= 80;

      return (
        <div className="py-4 border-b border-simona-border last:border-0">
          <div className="flex items-start justify-between mb-2">
            <div>
              <div className="text-[14px] font-medium text-simona-text mb-1">{title}</div>
              <div className="text-[13px] text-simona-textSecondary">{subtitle}</div>
            </div>
            <div className="text-[14px] text-simona-textSecondary font-medium">
              {Math.round(pct)}% 已使用
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="flex-1 h-2 bg-simona-border rounded-full overflow-hidden">
              <div
                className={`h-full rounded-full transition-all duration-500 ease-out ${isHigh ? 'bg-[#D93025]' : 'bg-[#3b82f6]'
                  }`}
                style={{ width: `${pct}%` }}
              />
            </div>
          </div>
        </div>
      );
    };

    return (
      <div className="space-y-8 animate-fade-in">
        <section>
          <h3 className="text-[16px] font-semibold text-simona-text mb-5">使用量</h3>

          {/* Selfhosted Mode Notice */}
          {usage.selfhosted_mode && (
            <div className="mb-6 p-5 bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800 rounded-xl">
              <h4 className="text-[14px] font-semibold text-simona-text mb-3 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-blue-500"></span>
                自托管模式
              </h4>
              <p className="text-[13px] text-simona-textSecondary leading-relaxed">
                您当前使用的是自托管模式(固定模式),用量统计需要连接到后端服务器才能正常工作。
              </p>
              <p className="text-[13px] text-simona-textSecondary leading-relaxed mt-2">
                如需查看用量统计,请切换到ClawParrot模式并配置API密钥。
              </p>
            </div>
          )}

          {/* 模型价格已隐藏 */}

          {/* Cost Statistics */}
          <div className="mb-6 p-5 bg-gradient-to-br from-green-50 to-emerald-50 dark:from-green-900/20 dark:to-emerald-900/20 border border-green-200 dark:border-green-800 rounded-xl">
            <h4 className="text-[14px] font-semibold text-simona-text mb-3 flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-500"></span>
              使用费用统计
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Total Cost */}
              <div className="p-4 bg-simona-hover rounded-lg border border-simona-border text-center">
                <div className="text-[12px] text-simona-textSecondary mb-1">预估总费用</div>
                <div className="text-[28px] font-bold text-[#5B9BFF]">${estimatedCost.toFixed(4)}</div>
                <div className="text-[11px] text-simona-textSecondary mt-1">基于当前用量估算</div>
              </div>

              {/* Token Usage */}
              <div className="p-4 bg-simona-hover rounded-lg border border-simona-border text-center">
                <div className="text-[12px] text-simona-textSecondary mb-1">Token 用量</div>
                <div className="text-[28px] font-bold text-[#5B9BFF]">{(tokenUsed / 1000).toFixed(1)}K</div>
                <div className="text-[11px] text-simona-textSecondary mt-1">{tokenUsed.toLocaleString()} tokens</div>
              </div>

              {/* Messages Count */}
              <div className="p-4 bg-simona-hover rounded-lg border border-simona-border text-center">
                <div className="text-[12px] text-simona-textSecondary mb-1">消息数量</div>
                <div className="text-[28px] font-bold text-[#5B9BFF]">{messages?.total || 0}</div>
                <div className="text-[11px] text-simona-textSecondary mt-1">今日: {messages?.today || 0}</div>
              </div>
            </div>
          </div>

          <div className="space-y-6">
            {/* Message Stats - HIDDEN */}
            {/* 
            {messages && (
              <div className="flex gap-4">
                <div className="flex-1 p-3 bg-simona-bg border border-simona-border rounded-xl text-center">
                  <div className="text-[20px] font-semibold text-simona-text">{messages.today}</div>
                  <div className="text-[12px] text-simona-textSecondary">今日消息</div>
                </div>
                <div className="flex-1 p-3 bg-simona-bg border border-simona-border rounded-xl text-center">
                  <div className="text-[20px] font-semibold text-simona-text">{messages.month}</div>
                  <div className="text-[12px] text-simona-textSecondary">本月消息</div>
                </div>
              </div>
            )}
            */}
          </div>
        </section>
      </div>
    );
  };
}

export default SettingsPage;

