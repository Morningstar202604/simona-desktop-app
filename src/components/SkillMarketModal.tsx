import React, { useState, useEffect } from 'react';
import { X, Download, Check, Loader2, Cloud } from 'lucide-react';
import { getSkillMarket, installSkill, getSkills } from '../api';

// 分类信息配置
const categoryConfig: Record<string, { name: string; icon: string; color: string }> = {
  douyin: { name: '抖音运营', icon: '🎯', color: '#FF6B6B' },
  tiktok: { name: 'TikTok运营', icon: '🌍', color: '#00BFFF' },
  image: { name: '图片生成', icon: '🖼️', color: '#9B59B6' },
  video: { name: '视频生成', icon: '🎬', color: '#2ECC71' },
};

interface SkillItem {
  id: string;
  name: string;
  description: string;
}

interface SkillMarketModalProps {
  category: string;
  onClose: () => void;
  onInstalled: (skillId: string) => void;
}

const SkillMarketModal: React.FC<SkillMarketModalProps> = ({ category, onClose, onInstalled }) => {
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [installedSkills, setInstalledSkills] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState<string | null>(null);
  const [error, setError] = useState('');

  const config = categoryConfig[category] || { name: category, icon: '📦', color: '#888' };

  useEffect(() => {
    loadMarket();
  }, [category]);

  const loadMarket = async () => {
    setLoading(true);
    setError('');
    try {
      const data = await getSkillMarket(category);
      const cat = data.categories?.[0];
      setSkills(cat?.skills || []);

      // 获取已安装技能列表
      const skillData = await getSkills();
      const all = [...(skillData.examples || []), ...(skillData.my_skills || [])];
      const installedIds = new Set<string>();
      for (const s of all) {
        // 从用户技能ID中提取原始skillId (user:xxx → xxx)
        const id = s.id.startsWith('user:') ? s.id.slice(5) : s.id;
        installedIds.add(id);
      }
      setInstalledSkills(installedIds);
    } catch (e: any) {
      setError('加载技能市场失败：' + (e.message || '未知错误'));
    } finally {
      setLoading(false);
    }
  };

  const handleInstall = async (skillId: string) => {
    setInstalling(skillId);
    try {
      const result = await installSkill(skillId);
      if (!result.already_installed) {
        setInstalledSkills(prev => new Set(prev).add(skillId));
        onInstalled(skillId);
      }
    } catch (e: any) {
      setError('安装失败：' + (e.message || '未知错误'));
    } finally {
      setInstalling(null);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center">
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/40 transition-opacity" onClick={onClose} />

      {/* 弹窗内容 */}
      <div className="relative w-[520px] max-h-[80vh] bg-white dark:bg-[#1c1c1c] rounded-2xl shadow-2xl border border-simona-border overflow-hidden flex flex-col">
        {/* 关闭按钮 */}
        <button
          onClick={onClose}
          className="absolute top-3 right-3 z-10 p-1.5 hover:bg-simona-hover rounded-lg transition-colors text-simona-textSecondary hover:text-simona-text"
        >
          <X size={16} />
        </button>

        {/* 内容区 */}
        <div className="flex-1 overflow-y-auto px-6 py-6 min-h-[200px]">
          {loading ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Loader2 size={28} className="animate-spin text-simona-textSecondary" />
              <span className="text-[13px] text-simona-textSecondary">正在加载云端技能...</span>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <div className="w-14 h-14 rounded-full bg-red-100 dark:bg-red-900/30 flex items-center justify-center">
                <Cloud size={28} className="text-red-400" />
              </div>
              <span className="text-[13px] text-red-400">{error}</span>
              <button
                onClick={loadMarket}
                className="mt-2 px-4 py-2 bg-simona-hover rounded-lg text-[13px] text-simona-text hover:bg-simona-btnHover transition-colors"
              >
                重新加载
              </button>
            </div>
          ) : skills.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 gap-3">
              <Cloud size={36} className="text-simona-textSecondary/40" />
              <span className="text-[14px] text-simona-textSecondary">该分类暂无可用技能</span>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              {skills.map((skill) => {
                const isInstalled = installedSkills.has(skill.id);
                const isInstalling = installing === skill.id;
                return (
                  <div
                    key={skill.id}
                    className="group relative flex flex-col p-4 rounded-xl bg-simona-input border border-simona-border hover:border-simona-btnHover transition-all duration-200"
                  >
                    {/* 技能信息 */}
                    <div className="flex-1">
                      <h3 className="text-[14px] font-medium text-simona-text mb-1">{skill.name}</h3>
                      <p className="text-[12px] text-simona-textSecondary leading-relaxed line-clamp-2">
                        {skill.description}
                      </p>
                    </div>

                    {/* 安装/已安装按钮 */}
                    <div className="mt-3 pt-3 border-t border-simona-border/50">
                      {isInstalled ? (
                        <div className="flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-green-500 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800/30">
                          <Check size={14} />
                          已安装
                        </div>
                      ) : (
                        <button
                          onClick={() => handleInstall(skill.id)}
                          disabled={isInstalling}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-[12px] font-medium text-white bg-[#5B9BFF] hover:bg-[#4A8AE6] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                        >
                          {isInstalling ? (
                            <>
                              <Loader2 size={14} className="animate-spin" />
                              安装中...
                            </>
                          ) : (
                            <>
                              <Download size={14} />
                              下载
                            </>
                          )}
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default SkillMarketModal;
