import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Search, Plus, ChevronDown, ArrowLeft, MoreVertical, Star, ArrowUp, FileText, Trash, Pencil, MessageSquare, X, Upload, Check, AudioLines, ChevronRight, Archive } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { Paperclip, ListCollapse } from 'lucide-react';
import { getProjects, createProject, getProject, updateProject, deleteProject, uploadProjectFile, deleteProjectFile, createProjectConversation, deleteConversation, getSkills, toggleProjectFile, getProviderModels, Project, ProjectFile } from '../api';
import ModelSelector, { SelectableModel } from './ModelSelector';
import { IconPlus } from './Icons';
import startProjectsImg from '../assets/icons/start-projects.png';

const ProjectsPage = () => {
  const { id: projectId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [searchQuery, setSearchQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [projectDescription, setProjectDescription] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [currentProject, setCurrentProject] = useState<any>(null);
  const [editingInstructions, setEditingInstructions] = useState(false);
  const [instructionsText, setInstructionsText] = useState('');
  const [uploading, setUploading] = useState(false);
  const [showMenu, setShowMenu] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [editName, setEditName] = useState('');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [sortBy, setSortBy] = useState<'activity' | 'edited' | 'created'>('activity');
  const [activeMenu, setActiveMenu] = useState<string | null>(null);
  const [projectToDelete, setProjectToDelete] = useState<Project | null>(null);
  const [projectToEdit, setProjectToEdit] = useState<Project | null>(null);
  const [editDetailsName, setEditDetailsName] = useState('');
  const [editDetailsDesc, setEditDetailsDesc] = useState('');
  const [message, setMessage] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [showPlusMenu, setShowPlusMenu] = useState(false);
  const [showSkillsSubmenu, setShowSkillsSubmenu] = useState(false);
  const [enabledSkills, setEnabledSkills] = useState<Array<{ id: string; name: string; description?: string }>>([]);
  const [selectedSkill, setSelectedSkill] = useState<{ name: string; slug: string; description?: string } | null>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const [showFileSelector, setShowFileSelector] = useState(false);

  // Model selector state — always load from providers config (providers.json),
  // so 项目对话使用 Sensenova 提供商的正确模型（默认 DeepSeek V4 Flash）
  const [selectorModels, setSelectorModels] = useState<SelectableModel[]>([]);
  const [currentModelString, setCurrentModelString] = useState('deepseek-v4-flash');
  const handleModelChange = (newModelString: string) => {
    setCurrentModelString(newModelString);
  };

  useEffect(() => {
    let cancelled = false;
    const loadModels = async () => {
      try {
        const pModels = await getProviderModels();
        if (cancelled) return;
        if (!pModels || pModels.length === 0) return;
        const models: SelectableModel[] = pModels.map(m => ({
          id: m.id,
          name: m.name || m.id,
          enabled: 1,
        }));
        setSelectorModels(models);
        // 默认模型：优先 deepseek-v4-flash，其次用户已选且有效的模型，再否则列表第一个
        const saved = localStorage.getItem('default_model');
        const flash = models.find(m => m.id === 'deepseek-v4-flash');
        const target = flash
          ? flash.id
          : (saved && models.some(m => m.id === saved) ? saved : models[0].id);
        setCurrentModelString(target);
        if (flash) localStorage.setItem('default_model', flash.id);
      } catch (_) {}
    };
    loadModels();
    return () => { cancelled = true; };
  }, []);

  const handleChatSubmit = async () => {
    if (!message.trim() || !currentProject) return;
    try {
      const conv = await createProjectConversation(currentProject.id, message.slice(0, 50), currentModelString);
      navigate(`/chat/${conv.id}`, { state: { initialMessage: message, model: currentModelString } });
      setMessage('');
    } catch (err) {
      console.error(err);
    }
  };

  const loadProjects = useCallback(async () => {
    try {
      const data = await getProjects();
      setProjects(data);
    } catch (_) { }
    setLoading(false);
  }, []);

  useEffect(() => { loadProjects(); }, [loadProjects]);

  // 如果有 projectId，加载项目详情
  useEffect(() => {
    if (projectId) {
      getProject(projectId).then((data: any) => {
        setCurrentProject(data);
        setInstructionsText(data.instructions || '');
      });
    }
  }, [projectId]);

  // Load skills when plus menu opens
  useEffect(() => {
    if (!showPlusMenu) { setShowSkillsSubmenu(false); return; }
    getSkills().then((data: any) => {
      const all = [...(data.examples || []), ...(data.my_skills || [])];
      setEnabledSkills(all.filter((s: any) => s.enabled).map((s: any) => ({ id: s.id, name: s.name, description: s.description })));
    }).catch(() => {});
  }, [showPlusMenu]);

  // Close plus menu on outside click
  useEffect(() => {
    if (!showPlusMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (plusMenuRef.current && !plusMenuRef.current.contains(e.target as Node) &&
        plusBtnRef.current && !plusBtnRef.current.contains(e.target as Node)) {
        setShowPlusMenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [showPlusMenu]);

  const loadProject = useCallback(async (id: string) => {
    try {
      const data = await getProject(id);
      setCurrentProject(data);
      setInstructionsText(data.instructions || '');
    } catch (_) { }
  }, []);

  const handleCreate = async () => {
    const name = projectName.trim() || 'Untitled Project';
    try {
      const project = await createProject(name, projectDescription.trim());
      setIsCreating(false);
      setProjectName('');
      setProjectDescription('');
      loadProject(project.id);
      loadProjects();
    } catch (_) { }
  };

  const handleDelete = async () => {
    if (!currentProject) return;
    if (!window.confirm(`确定要删除项目「${currentProject.name}」吗？所有关联的文件和对话也会被删除。`)) return;
    try {
      await deleteProject(currentProject.id);
      setCurrentProject(null);
      setShowMenu(false);
      loadProjects();
    } catch (_) { }
  };

  const handleDeleteProject = async (p: Project) => {
    try {
      await deleteProject(p.id);
      if (currentProject && currentProject.id === p.id) {
        setCurrentProject(null);
      }
      setProjectToDelete(null);
      loadProjects();
    } catch (_) { }
  };

  const handleSaveEditDetails = async () => {
    if (!projectToEdit) return;
    try {
      await updateProject(projectToEdit.id, {
        name: editDetailsName,
        description: editDetailsDesc
      });
      setProjectToEdit(null);
      loadProjects();
      if (currentProject && currentProject.id === projectToEdit.id) {
        loadProject(currentProject.id);
      }
    } catch (_) { }
  };

  const handleSaveInstructions = async () => {
    if (!currentProject) return;
    await updateProject(currentProject.id, { instructions: instructionsText });
    setEditingInstructions(false);
    loadProject(currentProject.id);
  };

  const handleFileUpload = async (files: FileList | File[]) => {
    if (!currentProject) return;
    setUploading(true);
    for (const file of Array.from(files)) {
      try {
        await uploadProjectFile(currentProject.id, file);
      } catch (_) { }
    }
    setUploading(false);
    loadProject(currentProject.id);
  };

  const handleDeleteFile = async (fileId: string) => {
    if (!currentProject) return;
    await deleteProjectFile(currentProject.id, fileId);
    loadProject(currentProject.id);
  };

  const handleToggleFile = async (fileId: string) => {
    if (!currentProject) return;
    const file = currentProject.files?.find((f: ProjectFile) => f.id === fileId);
    if (!file) return;
    await toggleProjectFile(currentProject.id, fileId, !file.enabled);
    loadProject(currentProject.id);
  };

  const handleNewChat = async () => {
    if (!currentProject) return;
    try {
      const conv = await createProjectConversation(currentProject.id);
      navigate(`/chat/${conv.id}`);
    } catch (_) { }
  };

  const handleDeleteConversation = async (convId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentProject) return;
    try {
      await deleteConversation(convId);
      loadProject(currentProject.id);
      loadProjects(); // refresh chat_count
    } catch (_) { }
  };

  const handleRenameSave = async () => {
    if (!currentProject || !editName.trim()) return;
    await updateProject(currentProject.id, { name: editName.trim() });
    setEditingName(false);
    loadProject(currentProject.id);
    loadProjects();
  };

  const filteredProjects = useMemo(() => {
    const filtered = projects.filter(p =>
      p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      p.description.toLowerCase().includes(searchQuery.toLowerCase())
    );
    return [...filtered].sort((a, b) => {
      if (sortBy === 'created') return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      // 'activity' and 'edited' both sort by updated_at
      return new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime();
    });
  }, [projects, searchQuery, sortBy]);

  // ═══ Project Detail View ═══
  if (currentProject) {
    return (
      <div className="flex-1 h-full bg-simona-bg overflow-y-auto">
        <div className="max-w-[800px] mx-auto px-8 py-12">
          <div className="mb-4">
            <button
              onClick={() => { setCurrentProject(null); loadProjects(); }}
              className="flex items-center gap-1.5 text-[14px] text-simona-textSecondary hover:text-simona-text transition-colors font-medium -ml-1"
            >
              <ArrowLeft size={16} />
              全部
            </button>
          </div>

          <div className="flex items-start justify-between mb-8 gap-4">
            <div className="flex-1 min-w-0">
              {editingName ? (
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={editName}
                    onChange={e => setEditName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleRenameSave(); if (e.key === 'Escape') setEditingName(false); }}
                    className="font-[Spectral] text-[32px] text-simona-text bg-transparent border-b-2 border-simona-accent outline-none w-full"
                    style={{ fontWeight: 500 }}
                  />
                </div>
              ) : (
                <h1
                  className="font-[Spectral] text-[32px] text-simona-text leading-tight mb-2"
                  style={{ fontWeight: 500 }}
                >
                  {currentProject.name}
                </h1>
              )}
              {currentProject.description && (
                <p className="text-[15.5px] text-simona-textSecondary">{currentProject.description}</p>
              )}
            </div>
            <div className="flex items-center gap-1 text-simona-textSecondary mt-2 flex-shrink-0">
            </div>
          </div>

          <div className="space-y-4">
            {/* Chat Input Container — matches MainContent new chat input */}
            <div
              className="bg-simona-input border border-simona-border dark:border-[#3a3a38] shadow-[0_2px_8px_rgba(0,0,0,0.02)] hover:shadow-[0_2px_8px_rgba(0,0,0,0.08)] hover:border-[#CCC] dark:hover:border-[#5a5a58] focus-within:shadow-[0_2px_8px_rgba(0,0,0,0.08)] focus-within:border-[#CCC] dark:focus-within:border-[#5a5a58] transition-all duration-200 flex flex-col max-h-[60vh] font-sans rounded-2xl"
            >
              {/* File Selector Bar */}
              {currentProject.files && currentProject.files.length > 0 && (
                <div className="px-4 pt-3 pb-2 border-b border-simona-border flex items-center gap-2">
                  <button
                    onClick={() => setShowFileSelector(!showFileSelector)}
                    className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-[13px] transition-colors ${
                      showFileSelector 
                        ? 'bg-[#4B9EFA]/10 text-[#4B9EFA] border border-[#4B9EFA]/30' 
                        : 'text-simona-textSecondary hover:text-simona-text hover:bg-black/5 dark:hover:bg-white/5 border border-transparent'
                    }`}
                  >
                    <FileText size={14} />
                    Applied Files ({currentProject.files.filter((f: ProjectFile) => f.enabled).length}/{currentProject.files.length})
                    <ChevronDown size={14} className={`transition-transform ${showFileSelector ? 'rotate-180' : ''}`} />
                  </button>
                  
                  {/* Quick apply/unapply all */}
                  {currentProject.files.filter((f: ProjectFile) => f.enabled).length < currentProject.files.length && (
                    <button
                      onClick={async () => {
                        if (!currentProject) return;
                        for (const f of currentProject.files) {
                          await toggleProjectFile(currentProject.id, f.id, true);
                        }
                        loadProject(currentProject.id);
                      }}
                      className="px-2 py-1 text-[12px] text-[#4B9EFA] hover:bg-[#4B9EFA]/10 rounded transition-colors"
                    >
                      全选
                    </button>
                  )}
                  {currentProject.files.filter((f: ProjectFile) => f.enabled).length > 0 && (
                    <button
                      onClick={async () => {
                        if (!currentProject) return;
                        for (const f of currentProject.files) {
                          await toggleProjectFile(currentProject.id, f.id, false);
                        }
                        loadProject(currentProject.id);
                      }}
                      className="px-2 py-1 text-[12px] text-[#A1A1AA] hover:text-[#E05A5A] hover:bg-red-500/10 rounded transition-colors"
                    >
                      取消全部
                    </button>
                  )}
                </div>
              )}
              
              {/* File Selector Dropdown */}
              {showFileSelector && currentProject.files && currentProject.files.length > 0 && (
                <div className="px-4 pb-3 border-b border-simona-border bg-black/[0.01] dark:bg-white/[0.01]">
                  <div className="max-h-[200px] overflow-y-auto space-y-1.5">
                    {currentProject.files.map((f: ProjectFile) => (
                      <button
                        key={f.id}
                        onClick={() => handleToggleFile(f.id)}
                        className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-colors ${
                          f.enabled 
                            ? 'bg-[#4B9EFA]/10 border border-[#4B9EFA]/30' 
                            : 'hover:bg-black/5 dark:hover:bg-white/5 border border-transparent'
                        }`}
                      >
                        <div className={`flex-shrink-0 w-4 h-4 rounded border-2 flex items-center justify-center ${
                          f.enabled ? 'bg-[#4B9EFA] border-[#4B9EFA]' : 'border-[#A1A1AA]'
                        }`}>
                          {f.enabled && <Check size={10} className="text-white" strokeWidth={3} />}
                        </div>
                        <FileText size={14} className={f.enabled ? 'text-[#4B9EFA]' : 'text-[#A1A1AA]'} />
                        <div className="flex-1 min-w-0">
                          <div className={`text-[13px] truncate ${f.enabled ? 'text-[#4B9EFA] font-medium' : 'text-simona-textSecondary'}`}>
                            {f.file_name}
                          </div>
                        </div>
                        <div className="text-[11px] text-[#A1A1AA] flex-shrink-0">
                          {f.file_size > 1024 * 1024 ? `${(f.file_size / 1024 / 1024).toFixed(1)} MB` : `${(f.file_size / 1024).toFixed(1)} KB`}
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              
              <div className="flex-1 overflow-y-auto min-h-0">
                <div className="relative">
                  {/* Skill overlay */}
                  {message.match(/^\/[a-zA-Z0-9_-]+/) && (
                    <div className="pl-5 pr-4 pt-5 pb-1 text-[16px] font-sans font-[350]" style={{ minHeight: '48px', position: 'absolute', top: 0, left: 0, right: 0, pointerEvents: 'none', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }} aria-hidden>
                      {(() => { const m = message.match(/^(\/[a-zA-Z0-9_-]+)([\s\S]*)$/); return m ? <><span className="text-[#4B9EFA]">{m[1]}</span><span className="text-simona-text">{m[2]}</span></> : null; })()}
                    </div>
                  )}
                  <textarea
                    ref={textareaRef}
                    className={`w-full pl-5 pr-4 pt-5 pb-1 placeholder:text-simona-textSecondary text-[16px] outline-none resize-none overflow-hidden bg-transparent font-sans font-[350] ${message.match(/^\/[a-zA-Z0-9_-]+/) ? 'text-transparent caret-simona-text' : 'text-simona-text'}`}
                    style={{ minHeight: '48px', borderRadius: '16px 16px 0 0' }}
                    placeholder={selectedSkill ? `描述您希望 ${selectedSkill.name} 做什么...` : "今天有什么可以帮您的？"}
                    value={message}
                    onChange={(e) => {
                      setMessage(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 300) + 'px';
                      e.target.style.overflowY = e.target.scrollHeight > 300 ? 'auto' : 'hidden';
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Backspace' && selectedSkill) {
                        const pos = (e.target as HTMLTextAreaElement).selectionStart;
                        const prefix = `/${selectedSkill.slug} `;
                        if (pos > 0 && pos <= prefix.length && message.startsWith(prefix.slice(0, pos))) {
                          e.preventDefault();
                          setMessage(message.slice(prefix.length));
                          setSelectedSkill(null);
                          return;
                        }
                      }
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        handleChatSubmit();
                      }
                    }}
                  />
                </div>
              </div>
              <div className="px-4 pb-3 pt-1 flex items-center justify-between flex-shrink-0">
                <div className="relative flex items-center">
                  <button
                    ref={plusBtnRef}
                    onClick={() => setShowPlusMenu(prev => !prev)}
                    className="p-2 text-simona-textSecondary hover:text-simona-text hover:bg-simona-hover rounded-lg transition-colors"
                  >
                    <IconPlus size={20} />
                  </button>
                  {showPlusMenu && (
                    <div ref={plusMenuRef} className="absolute bottom-full left-0 mb-2 w-[220px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50">
                      <button onClick={() => { setShowPlusMenu(false); fileInputRef.current?.click(); }} className="w-full flex items-center gap-3 px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors">
                        <Paperclip size={16} className="text-simona-textSecondary" />
                        Add files or photos
                      </button>
                      <div className="relative">
                        <button onMouseEnter={() => setShowSkillsSubmenu(true)} onClick={() => setShowSkillsSubmenu(p => !p)} className="w-full flex items-center justify-between px-4 py-2.5 text-[13px] text-simona-text hover:bg-simona-hover transition-colors">
                          <div className="flex items-center gap-3"><FileText size={16} className="text-simona-textSecondary" />技能</div>
                          <ChevronDown size={14} className="text-simona-textSecondary -rotate-90" />
                        </button>
                        {showSkillsSubmenu && (
                          <div className="absolute left-full bottom-0 ml-1 w-[200px] bg-simona-input border border-simona-border rounded-xl shadow-[0_4px_16px_rgba(0,0,0,0.12)] py-1.5 z-50 max-h-[300px] overflow-y-auto" onMouseLeave={() => setShowSkillsSubmenu(false)}>
                            {enabledSkills.length > 0 ? enabledSkills.map(skill => (
                              <button key={skill.id} onClick={() => {
                                setShowPlusMenu(false); setShowSkillsSubmenu(false);
                                const slug = skill.name.toLowerCase().replace(/\s+/g, '-');
                                setSelectedSkill({ name: skill.name, slug, description: skill.description });
                                setMessage(prev => prev ? `/${slug} ${prev}` : `/${slug} `);
                                textareaRef.current?.focus();
                              }} className="w-full text-left px-4 py-2 text-[13px] text-simona-text hover:bg-simona-hover transition-colors truncate">{skill.name}</button>
                            )) : <div className="px-4 py-2 text-[12px] text-simona-textSecondary italic">暂无可用技能</div>}
                            <div className="border-t border-simona-border mt-1 pt-1">
                              <button onClick={() => { setShowPlusMenu(false); window.location.hash = '#/customize'; }} className="w-full flex items-center gap-3 px-4 py-2 text-[13px] text-simona-textSecondary hover:bg-simona-hover transition-colors"><FileText size={14} />管理技能</button>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-3">
                  <ModelSelector
                    currentModelString={currentModelString}
                    models={selectorModels}
                    onModelChange={handleModelChange}
                    isNewChat={true}
                  />
                  <button
                    onClick={handleChatSubmit}
                    disabled={!message.trim()}
                    className={`p-2 rounded-lg transition-colors disabled:cursor-not-allowed ${
                      !message.trim()
                        ? 'bg-simona-input text-simona-textSecondary/40'
                        : 'bg-simona-hover text-simona-text hover:bg-simona-btn-hover'
                    }`}
                  >
                    <ArrowUp size={22} strokeWidth={2.5} />
                  </button>
                </div>
              </div>
            </div>

            {/* Conversation List / Banner */}
            {currentProject.conversations && currentProject.conversations.length > 0 ? (
              <div className="border border-simona-border rounded-[16px] overflow-hidden bg-transparent mt-2">
                <div className="px-5 py-3 text-[13px] font-medium text-simona-textSecondary border-b border-simona-border">
                  {currentProject.conversations.length} 个对话
                </div>
                {currentProject.conversations.map((conv: any) => (
                  <div
                    key={conv.id}
                    onClick={() => navigate(`/chat/${conv.id}`)}
                    className="px-5 py-3 flex items-center gap-3 hover:bg-simona-hover cursor-pointer border-b border-simona-border last:border-b-0 transition-colors group"
                  >
                    <MessageSquare size={16} className="text-simona-textSecondary flex-shrink-0" />
                    <span className="text-[14px] text-simona-text truncate">{conv.title}</span>
                    <span className="text-[12px] text-simona-textSecondary ml-auto flex-shrink-0">
                      {new Date(conv.created_at).toLocaleDateString()}
                    </span>
                    <button
                      onClick={(e) => handleDeleteConversation(conv.id, e)}
                      className="p-1 text-simona-textSecondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
                      title="Delete conversation"
                    >
                      <Trash size={14} />
                    </button>
                  </div>
                ))}
              </div>
            ) : (
              <div className="w-full border border-simona-border rounded-[16px] px-6 py-10 flex items-center justify-center bg-transparent mt-2">
                <span className="text-[14.5px] text-[#A1A1AA]">
                  开始对话以保持对话有条理，并重用项目知识。
                </span>
              </div>
            )}

            {/* Instructions and Files */}
            <div className="w-full border border-simona-border rounded-[16px] overflow-hidden bg-transparent mt-2">
              {/* Instructions Header */}
              <div
                className="p-5 border-b border-simona-border hover:bg-black/[0.015] dark:hover:bg-white/[0.015] transition-colors cursor-pointer group"
                onClick={() => { if (!editingInstructions) setEditingInstructions(true); }}
              >
                <div className="flex items-center justify-between">
                  <div className="flex-1">
                    <h3 className="font-semibold text-simona-text mb-0.5" style={{ fontSize: '15.5px' }}>说明</h3>
                    {!editingInstructions && (
                      <p className="text-[13px] text-[#A1A1AA]">
                        {currentProject.instructions
                          ? currentProject.instructions.slice(0, 200) + (currentProject.instructions.length > 200 ? '...' : '')
                          : '添加说明以定制智能体的回复'}
                      </p>
                    )}
                  </div>
                  {!editingInstructions && (
                    <button className="text-[#A1A1AA] hover:text-simona-text transition-colors">
                      {currentProject.instructions ? <Pencil size={18} strokeWidth={1.5} /> : <Plus size={22} strokeWidth={1.5} />}
                    </button>
                  )}
                </div>
                {editingInstructions && (
                  <div
                    className="fixed inset-0 z-50 flex items-center justify-center bg-black/70"
                    onClick={() => { setEditingInstructions(false); setInstructionsText(currentProject.instructions || ''); }}
                  >
                    <div
                      className="w-full max-w-[800px] bg-white dark:bg-[#2A2928] border border-simona-border rounded-[20px] shadow-2xl p-7"
                      onClick={e => e.stopPropagation()}
                    >
                      <h2 className="text-[20px] font-bold text-simona-text mb-2">设置项目说明</h2>
                      <p className="text-[14px] text-[#A1A1AA] mb-5">
                        向智能体提供相关的说明和信息，以便在 {currentProject.name} 内的对话中使用。这将与聊天中选择的<span className="underline decoration-[#555] underline-offset-2 cursor-pointer hover:text-simona-text">用户偏好</span>和样式一起工作。
                      </p>

                      <textarea
                        autoFocus
                        value={instructionsText}
                        onChange={e => setInstructionsText(e.target.value)}
                        placeholder="分解大型任务并在需要时提出澄清问题。"
                        className="w-full h-[400px] px-4 py-3 bg-simona-bg dark:bg-[#202020] border border-simona-border rounded-[12px] text-[15px] text-simona-text resize-none outline-none focus:border-[#3A7ADA] focus:ring-1 focus:ring-[#3A7ADA] transition-colors"
                      />

                      <div className="flex justify-end gap-3 mt-5">
                        <button
                          onClick={() => { setEditingInstructions(false); setInstructionsText(currentProject.instructions || ''); }}
                          className="px-4 py-2 text-[14px] font-medium text-simona-text hover:bg-white/5 border border-transparent hover:border-simona-border rounded-xl transition-all"
                        >
                          取消
                        </button>
                        <button
                          onClick={handleSaveInstructions}
                          className="px-4 py-2 text-[14px] font-medium bg-[#E6E6E6] text-[#222] rounded-xl hover:opacity-90 transition-opacity"
                        >
                          保存说明
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              {/* Files */}
              <div className="p-5 pb-6">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="font-semibold text-simona-text" style={{ fontSize: '15.5px' }}>
                    文件 {currentProject.files?.length > 0 && <span className="text-simona-textSecondary text-[13px] ml-1">({currentProject.files.length})</span>}
                    {currentProject.files && currentProject.files.filter((f: ProjectFile) => f.enabled).length > 0 && (
                      <span className="text-[12px] text-[#4B9EFA] ml-2">• {currentProject.files.filter((f: ProjectFile) => f.enabled).length} 已应用</span>
                    )}
                  </h3>
                  <button
                    onClick={() => fileInputRef.current?.click()}
                    className="text-[#A1A1AA] hover:text-simona-text transition-colors"
                  >
                    <Plus size={22} strokeWidth={1.5} />
                  </button>
                  <input
                    ref={fileInputRef}
                    type="file"
                    multiple
                    className="hidden"
                    onChange={e => { if (e.target.files) handleFileUpload(e.target.files); e.target.value = ''; }}
                  />
                </div>

                {uploading && (
                  <div className="text-[13px] text-simona-textSecondary animate-pulse mb-3">上传中...</div>
                )}

                {currentProject.files && currentProject.files.length > 0 ? (
                  <div className="space-y-2">
                    {currentProject.files.map((f: ProjectFile) => (
                      <div key={f.id} className="flex items-center gap-3 px-3 py-2.5 rounded-[12px] bg-black/[0.02] dark:bg-white/[0.03] group border border-transparent hover:border-simona-border transition-all">
                        {/* File enable checkbox */}
                        <button
                          onClick={() => handleToggleFile(f.id)}
                          className={`flex-shrink-0 w-5 h-5 rounded border-2 flex items-center justify-center transition-all ${
                            f.enabled 
                              ? 'bg-[#4B9EFA] border-[#4B9EFA]' 
                              : 'border-[#A1A1AA] hover:border-[#4B9EFA]'
                          }`}
                        >
                          {f.enabled && <Check size={12} className="text-white" strokeWidth={3} />}
                        </button>
                        
                        <FileText size={16} className="text-[#A1A1AA] flex-shrink-0" />
                        <div className="flex-1 min-w-0">
                          <div className="text-[13.5px] text-simona-text truncate font-medium">{f.file_name}</div>
                          <div className="text-[11.5px] text-[#A1A1AA]">
                            {f.file_size > 1024 * 1024 ? `${(f.file_size / 1024 / 1024).toFixed(1)} MB` : `${(f.file_size / 1024).toFixed(1)} KB`}
                          </div>
                        </div>
                        <button
                          onClick={() => handleDeleteFile(f.id)}
                          className="p-1 text-[#A1A1AA] hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                        >
                          <X size={16} />
                        </button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    className="w-full bg-[#FAFAFA] dark:bg-[#191919] rounded-[16px] flex flex-col items-center justify-center py-8 border border-transparent dark:border-white/[0.04] cursor-pointer hover:bg-[#F3F3F3] dark:hover:bg-[#222222] transition-colors"
                    onClick={() => fileInputRef.current?.click()}
                    onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                    onDrop={e => { e.preventDefault(); e.stopPropagation(); if (e.dataTransfer.files.length) handleFileUpload(e.dataTransfer.files); }}
                  >
                    <div className="flex items-center justify-center mb-3">
                      <div className="w-[84px] h-[48px] relative opacity-60 mix-blend-luminosity grayscale">
                        <div className="absolute right-[4px] bottom-0 w-[28px] h-[36px] bg-[#3B3B3B] border border-[#555] rounded-[4px] flex flex-col items-center py-1.5 px-1 gap-[3px] shadow-sm transform translate-x-2 translate-y-2 -rotate-12 z-0">
                          <div className="w-full h-[1.5px] bg-[#666] rounded-full mx-1"></div>
                          <div className="w-3/4 h-[1.5px] bg-[#666] rounded-full mx-1 self-start"></div>
                        </div>
                        <div className="absolute left-[4px] bottom-0 w-[28px] h-[36px] bg-[#3B3B3B] border border-[#555] rounded-[4px] flex flex-col items-center py-1.5 px-1 gap-[3px] shadow-sm transform -translate-x-2 translate-y-1 rotate-12 z-0">
                          <div className="w-full h-[1.5px] bg-[#666] rounded-full mx-1"></div>
                          <div className="w-full h-[1.5px] bg-[#666] rounded-full mx-1"></div>
                          <div className="w-1/2 h-[1.5px] bg-[#666] rounded-full mx-1 self-start"></div>
                        </div>
                        <div className="absolute left-1/2 bottom-0 -translate-x-1/2 w-[34px] h-[42px] bg-[#444] border border-[#666] rounded-[6px] shadow-md flex flex-col items-center py-2 px-1.5 gap-[4px] z-10">
                          <div className="w-[12px] h-[12px] bg-[#555] rounded-sm flex items-center justify-center self-end mb-0.5"><Plus size={8} className="text-white" /></div>
                          <div className="w-full h-[2px] bg-[#888] rounded-full mx-1"></div>
                          <div className="w-full h-[2px] bg-[#888] rounded-full mx-1"></div>
                          <div className="w-2/3 h-[2px] bg-[#888] rounded-full mx-1 self-start"></div>
                        </div>
                      </div>
                    </div>
                    <span className="text-[13px] text-[#A1A1AA] text-center max-w-[200px] leading-relaxed">
                      添加 PDF、文档或其他文本，以便在此项目中参考。
                    </span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ═══ Create View ═══
  if (isCreating) {
    return (
      <div className="flex-1 h-full bg-simona-bg overflow-y-auto">
        <div className="max-w-[560px] mx-auto px-8 pt-12 pb-8">
          <h1 className="font-[Spectral] text-[32px] text-simona-text mb-6" style={{ fontWeight: 600 }}>
            创建个人项目
          </h1>

          <div className="bg-[#EFEEE7] dark:bg-[#2A2928] rounded-2xl p-6 mb-6 border border-transparent dark:border-white/5">
            <h3 className="font-semibold text-simona-text text-[15.5px] mb-2 text-[#403A35] dark:text-[#E3E0D8]">如何使用项目</h3>
            <p className="text-[14.5px] leading-relaxed text-[#564E48] dark:text-[#A8A096] mb-3">
              项目帮助您组织工作，并在多个对话中利用知识。上传文档、代码和文件，创建主题集合，让 AI 可以反复参考。
            </p>
            <p className="text-[14.5px] leading-relaxed text-[#564E48] dark:text-[#A8A096]">
              首先创建一个易记的标题和描述来组织您的项目，之后随时可以编辑。
            </p>
          </div>

          <div className="space-y-5">
            <div>
              <label className="block text-[15px] font-medium text-simona-textSecondary mb-2">您要做什么？</label>
              <input
                type="text"
                placeholder="为您的项目命名"
                value={projectName}
                onChange={e => setProjectName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && projectName.trim()) handleCreate(); }}
                className="w-full px-4 py-3 bg-white dark:bg-simona-input border border-gray-200 dark:border-simona-border rounded-xl text-simona-text placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#387ee0] focus:ring-0 transition-all text-[15px]"
              />
            </div>
            <div>
              <label className="block text-[15px] font-medium text-simona-textSecondary mb-2">您想要达成什么目标？</label>
              <textarea
                placeholder="描述您的项目、目标、主题等..."
                rows={3}
                value={projectDescription}
                onChange={e => setProjectDescription(e.target.value)}
                className="w-full px-4 py-3 bg-white dark:bg-simona-input border border-gray-200 dark:border-simona-border rounded-xl text-simona-text placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:border-[#387ee0] focus:ring-0 transition-all text-[15px] resize-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 mt-6">
            <button
              onClick={() => { setIsCreating(false); setProjectName(''); setProjectDescription(''); }}
              className="px-5 py-2.5 text-[15px] font-medium text-simona-text bg-white dark:bg-simona-bg border border-gray-300 dark:border-simona-border hover:bg-gray-50 dark:hover:bg-simona-hover rounded-xl transition-colors"
            >
              取消
            </button>
            <button
              onClick={handleCreate}
              disabled={!projectName.trim()}
              className="px-5 py-2.5 text-[15px] font-medium text-simona-bg bg-black dark:bg-white dark:text-black hover:opacity-90 rounded-xl transition-opacity disabled:opacity-40"
            >
              创建项目
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ═══ Projects List View ═══
  return (
    <div className="flex-1 h-full bg-simona-bg overflow-y-auto">
      <div className="max-w-[800px] mx-auto px-8 py-12">
        <div className="flex items-center justify-between mb-8">
          <h1 className="font-[Spectral] text-[32px] text-simona-text" style={{ fontWeight: 500 }}>项目</h1>
          <button
            onClick={() => setIsCreating(true)}
            className="flex items-center gap-2 px-3.5 py-1.5 bg-simona-text text-simona-bg hover:opacity-90 rounded-lg transition-opacity font-medium"
            style={{ fontSize: '14px' }}
          >
            <Plus size={16} strokeWidth={2.5} />
            新项目
          </button>
        </div>

        {projects.length > 0 && (
          <>
            <div className="relative mb-6">
              <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-simona-textSecondary opacity-80" />
              </div>
              <input
                type="text"
                placeholder="搜索项目..."
                value={searchQuery}
                onChange={e => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-3 bg-white dark:bg-simona-input border border-gray-200 dark:border-simona-border rounded-xl text-simona-text placeholder-simona-textSecondary focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 transition-all text-[15px]"
              />
            </div>

            <div className="flex justify-end mb-6">
              <div className="flex items-center gap-3 text-[14.5px] text-[#A1A1AA] relative">
                <span>排序</span>
                <button
                  onClick={() => setSortMenuOpen(!sortMenuOpen)}
                  className={`flex items-center gap-2 text-simona-text border border-[#3A3A3A] hover:border-[#4A4A4A] dark:border-simona-border dark:hover:bg-simona-hover rounded-[10px] px-3.5 py-1.5 transition-colors ${sortMenuOpen ? 'bg-simona-hover' : ''}`}
                >
                  {sortBy === 'activity' ? '最近活动' : sortBy === 'edited' ? '最近编辑' : '创建日期'}
                  <ChevronDown size={14} className="text-simona-textSecondary" />
                </button>
                {sortMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setSortMenuOpen(false)} />
                    <div className="absolute top-full right-0 mt-1.5 w-[200px] bg-white dark:bg-[#2A2928] border border-gray-200 dark:border-simona-border rounded-[14px] shadow-lg py-1.5 z-50">
                      {[
                        { id: 'activity', label: '最近活动' },
                        { id: 'edited', label: '最近编辑' },
                        { id: 'created', label: '创建日期' },
                      ].map(opt => (
                        <button
                          key={opt.id}
                          onClick={() => {
                            setSortBy(opt.id as any);
                            setSortMenuOpen(false);
                          }}
                          className="w-full flex items-center justify-between px-4 py-2.5 text-[15px] text-simona-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors"
                        >
                          {opt.label}
                          {sortBy === opt.id && <Check size={16} className="text-simona-text opacity-80" />}
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}

        {loading ? (
          <div className="text-center text-simona-textSecondary text-[14px] mt-12">加载中...</div>
        ) : filteredProjects.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {filteredProjects.map(p => (
              <div
                key={p.id}
                onClick={() => loadProject(p.id)}
                className="flex flex-col p-5 border border-simona-border rounded-[12px] bg-transparent hover:bg-black/[0.02] dark:hover:bg-white/[0.02] cursor-pointer transition-colors group min-h-[170px]"
              >
                <div className="flex items-center justify-between mb-2.5 relative">
                  <div className="flex items-center gap-3">
                    <h3 className="text-[15.5px] font-medium text-simona-text truncate">{p.name}</h3>
                  </div>
                  <div className="relative" onClick={(e) => e.stopPropagation()}>
                    <button
                      onClick={(e) => { e.stopPropagation(); setActiveMenu(activeMenu === p.id ? null : p.id); }}
                      className={`p-1 text-[#A1A1AA] hover:text-simona-text hover:bg-black/5 dark:hover:bg-white/5 rounded-[6px] transition-all ${activeMenu === p.id ? 'opacity-100 bg-black/5 dark:bg-white/5' : 'opacity-0 group-hover:opacity-100'}`}
                    >
                      <MoreVertical size={18} />
                    </button>

                    {activeMenu === p.id && (
                      <>
                        <div className="fixed inset-0 z-40" onClick={(e) => { e.stopPropagation(); setActiveMenu(null); }} />
                        <div className="absolute top-full right-0 mt-1 w-[180px] bg-white dark:bg-[#30302E] rounded-[16px] shadow-[0_4px_24px_rgba(0,0,0,0.15)] border border-gray-200 dark:border-[#65645F] py-1.5 z-50">
                          <button className="w-full flex items-center gap-3 px-4 py-2.5 text-[14px] text-simona-text hover:bg-black/5 dark:hover:bg-white/5 transition-colors text-left" onClick={(e) => { e.stopPropagation(); setActiveMenu(null); setProjectToEdit(p); setEditDetailsName(p.name); setEditDetailsDesc(p.description || ''); }}>
                            <Pencil size={16} className="text-simona-textSecondary" />
                            编辑详情
                          </button>
                          <div className="my-1.5 border-t border-simona-border opacity-50" />
                          <button className="w-full flex items-center gap-3 px-4 py-2.5 text-[14px] text-[#E05A5A] hover:bg-red-500/10 transition-colors text-left" onClick={(e) => { e.stopPropagation(); setActiveMenu(null); setProjectToDelete(p); }}>
                            <Trash size={16} className="text-[#E05A5A]" />
                            删除
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                </div>

                <p className="text-[14px] text-simona-textSecondary line-clamp-3 leading-relaxed flex-1">
                  {p.description || "暂无描述。"}
                </p>

                <div className="mt-4 pt-1 flex items-center gap-4 text-[12px] text-simona-textSecondary/80">
                  <span>更新于 {new Date(p.updated_at).toLocaleDateString()}</span>
                  {(p.file_count ?? 0) > 0 && <span>• {p.file_count} 个文件</span>}
                  {(p.chat_count ?? 0) > 0 && <span>• {p.chat_count} 个对话</span>}
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center mt-12">
            <img src={startProjectsImg} alt="开始一个项目" className="w-[100px] h-auto mb-6 dark:invert opacity-90" />
            <h2 className="text-[17px] font-medium text-simona-text mb-3">想开始一个项目吗？</h2>
            <p className="text-[15px] text-simona-textSecondary text-center max-w-[400px] leading-relaxed mb-6">
              上传材料，设置自定义说明，并将对话组织在一个空间内。
            </p>
            <button
              onClick={() => setIsCreating(true)}
              className="flex items-center gap-2 px-4 py-2 bg-transparent border border-simona-border hover:bg-simona-hover rounded-xl text-simona-text transition-colors text-[14.5px] font-medium"
            >
              <Plus size={18} strokeWidth={2.5} />
              新项目
            </button>
          </div>
        )}
      </div>

      {projectToDelete && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-simona-input w-[460px] rounded-[16px] flex flex-col shadow-2xl relative border border-simona-border overflow-hidden">
            <div className="px-6 pt-6 pb-4 text-left">
              <h3 className="text-[19px] font-semibold text-simona-text mb-3">删除项目</h3>
              <p className="text-[15px] text-simona-textSecondary leading-relaxed pr-4">
                确定要删除项目「{projectToDelete.name}」吗？所有关联的文件和对话也会被删除。
              </p>
            </div>
            <div className="px-5 pb-5 pt-2 flex justify-end gap-3 mt-4">
              <button
                onClick={() => setProjectToDelete(null)}
                className="px-5 py-2 text-[14.5px] font-medium text-simona-text border border-simona-border hover:bg-simona-hover rounded-[8px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => handleDeleteProject(projectToDelete)}
                className="px-5 py-2 text-[14.5px] font-medium text-white bg-[#E05A5A] hover:bg-[#E86B6B] rounded-[8px] transition-colors"
              >
                删除
              </button>
            </div>
          </div>
        </div>
      )}

      {projectToEdit && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm p-4">
          <div className="bg-simona-input w-[460px] rounded-[16px] flex flex-col shadow-2xl relative border border-simona-border overflow-hidden">
            <div className="px-6 pt-6 pb-4 text-left">
              <h3 className="text-[19px] font-semibold text-simona-text mb-5">编辑详情</h3>

              <div className="space-y-4">
                <div>
                  <label className="block text-[14px] text-simona-textSecondary mb-2 font-medium">名称</label>
                  <input
                    type="text"
                    value={editDetailsName}
                    onChange={(e) => setEditDetailsName(e.target.value)}
                    className="w-full px-3 py-2 bg-transparent border border-simona-border rounded-[8px] text-simona-text outline-none focus:border-[#3A7ADA] focus:ring-1 focus:ring-[#3A7ADA] transition-all text-[15px]"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-[14px] text-simona-textSecondary mb-2 font-medium">描述</label>
                  <textarea
                    value={editDetailsDesc}
                    onChange={(e) => setEditDetailsDesc(e.target.value)}
                    rows={4}
                    className="w-full px-3 py-2 bg-simona-bg border border-simona-border rounded-[8px] text-simona-text outline-none focus:border-[#3A7ADA] focus:ring-1 focus:ring-[#3A7ADA] transition-all resize-none text-[14.5px] leading-relaxed"
                  />
                </div>
              </div>
            </div>

            <div className="px-6 pb-6 pt-2 flex justify-end gap-3 mt-4">
              <button
                onClick={() => setProjectToEdit(null)}
                className="px-5 py-2.5 text-[14.5px] font-medium text-simona-text border border-simona-border hover:bg-simona-hover rounded-[8px] transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveEditDetails}
                className="px-5 py-2.5 text-[14.5px] font-medium bg-simona-text text-simona-bg hover:opacity-90 rounded-[8px] transition-opacity"
              >
                保存
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default ProjectsPage;
