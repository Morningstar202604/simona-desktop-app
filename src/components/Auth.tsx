import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { Mail, Lock, Send, ArrowRight, Check } from 'lucide-react';
import { login, register, sendCode, forgotPassword, resetPassword, gatewayLogin } from '../api';
import faviconLogo from '../assets/icons/favicon_128.png';
// 改用新的透明背景 favicon
const loginLogoUrl = '/favicon.png';

type View = 'login' | 'register' | 'verify' | 'forgot' | 'reset';

const Auth = () => {
  const navigate = useNavigate();
  const [view, setView] = useState<View>('login');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [loading, setLoading] = useState(false);
  const [countdown, setCountdown] = useState(0);

  useEffect(() => {
    if (countdown <= 0) return;
    const timer = setTimeout(() => setCountdown(countdown - 1), 1000);
    return () => clearTimeout(timer);
  }, [countdown]);

  const isElectron = !!(window as any).electronAPI?.isElectron;
  
  // 获取 API 基础 URL
  const getApiBase = () => {
    if (isElectron) {
      return 'http://127.0.0.1:30080';
    }
    return window.location.origin;
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    if (!code) {
      setError('请输入验证码');
      return;
    }
    
    setError(''); setLoading(true);
    try {
      // 验证验证码
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/api/auth/verify-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || '验证失败');
      }
      
      // 验证成功,保存登录状态
      localStorage.setItem('logged_in_email', email);
      localStorage.setItem('user_mode', 'selfhosted');
      import('../utils/modelSettingsSync').then(mod => mod.saveSettingsToServer());
      if (data.jwt) {
        localStorage.setItem('auth_token', data.jwt);
      }
      window.location.hash = '#/'; 
      window.location.reload();
    } catch (err: any) {
      setError(err.message || '登录失败');
    } finally { setLoading(false); }
  };

  const handleSendCode = async () => {
    if (countdown > 0) return;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('请输入有效的邮箱地址');
      return;
    }
    setError(''); setLoading(true);
    try {
      // 调用后端 API 发送验证码
      const apiBase = getApiBase();
      const response = await fetch(`${apiBase}/api/auth/send-code`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email })
      });
      
      const data = await response.json();
      
      if (!response.ok) {
        throw new Error(data.error || '发送失败');
      }
      
      setCountdown(60);
      setMessage(data.message || '验证码已发送');
      setTimeout(() => setMessage(''), 3000);
    } catch (err: any) {
      setError(err.message || '发送失败');
    } finally { setLoading(false); }
  };



  const switchView = (v: View) => {
    setView(v); setError(''); setMessage(''); setCode('');
  };

  const inputClass = "w-full px-3 py-2 border border-[#E5E5E5] rounded-lg focus:outline-none focus:ring-2 focus:ring-[#CC7C5E] focus:border-transparent transition-all";
  const btnClass = "w-full py-2.5 bg-[#CC7C5E] hover:bg-[#B96B4E] text-white font-medium rounded-lg transition-colors disabled:opacity-70 disabled:cursor-not-allowed";

  const userMode = localStorage.getItem('user_mode');
  const showClawparrotHint = isElectron && userMode === 'clawparrot';

  const handleSkipLogin = () => {
    // 切换到自部署模式, 不走 clawparrot 网关. 用户之后可以在 Settings → Models 里配置自己的 provider.
    localStorage.setItem('user_mode', 'selfhosted');
    import('../utils/modelSettingsSync').then(mod => mod.saveSettingsToServer());
    localStorage.removeItem('SIMONA_API_KEY');
    localStorage.removeItem('SIMONA_BASE_URL');
    localStorage.removeItem('gateway_user');
    localStorage.removeItem('auth_token');
    window.location.hash = '#/';
    window.location.reload();
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-[#0a0a0a] via-[#1a1a2e] to-[#16213e] flex items-center justify-center font-sans relative overflow-hidden">
      {/* 背景装饰 */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        {/* 渐变光晕 */}
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-[#5B9BFF]/10 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-[#CC7C5E]/10 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '1s' }}></div>
        <div className="absolute top-1/2 left-1/2 w-64 h-64 bg-purple-500/5 rounded-full blur-3xl animate-pulse" style={{ animationDelay: '2s' }}></div>
        
        {/* 网格线 */}
        <div className="absolute inset-0 opacity-[0.02]" style={{
          backgroundImage: `linear-gradient(rgba(255,255,255,0.1) 1px, transparent 1px),
                           linear-gradient(90deg, rgba(255,255,255,0.1) 1px, transparent 1px)`,
          backgroundSize: '50px 50px'
        }}></div>
        
        {/* 浮动粒子 */}
        <div className="absolute top-20 left-20 w-2 h-2 bg-[#5B9BFF]/30 rounded-full animate-bounce" style={{ animationDuration: '3s' }}></div>
        <div className="absolute top-40 right-32 w-3 h-3 bg-[#5B9BFF]/20 rounded-full animate-bounce" style={{ animationDuration: '4s', animationDelay: '1s' }}></div>
        <div className="absolute bottom-32 left-40 w-2 h-2 bg-[#CC7C5E]/30 rounded-full animate-bounce" style={{ animationDuration: '3.5s', animationDelay: '0.5s' }}></div>
      </div>

      {showClawparrotHint && (
        <button
          onClick={handleSkipLogin}
          className="absolute top-6 right-6 px-4 py-2 text-sm text-white/60 hover:text-white hover:bg-white/10 rounded-lg transition-all backdrop-blur-sm border border-white/10"
        >
          跳过登录
        </button>
      )}

      {/* 登录框 - 居中显示，不可移动 */}
      <div 
        className="relative z-10 w-full flex items-center justify-center"
        style={{ ['WebkitAppRegion' as string]: 'no-drag' } as React.CSSProperties}
      >
        <div
          className="w-[480px] bg-gradient-to-br from-white/[0.95] to-white/[0.85] dark:from-[#1e1e2e]/[0.95] dark:to-[#1a1a2e]/[0.85] backdrop-blur-2xl rounded-3xl shadow-2xl border border-white/20 dark:border-white/10 overflow-hidden hover:shadow-[#5B9BFF]/10 transition-shadow duration-500"
        >
          {/* 标题区域 - 不可拖拽 */}
          <div className="px-8 pt-8 pb-4 select-none">
            <h1 className="text-center text-3xl font-bold bg-gradient-to-r from-[#5B9BFF] to-[#7BB3FF] dark:from-[#7BB3FF] dark:to-[#9BC5FF] bg-clip-text text-transparent mb-2 tracking-tight">
              Simona
            </h1>
            <p className="text-center text-sm text-gray-600 dark:text-gray-400 font-medium">
              欢迎回来，请登录以继续使用
            </p>
          </div>

          {/* 分割线 */}
          <div className="mx-8 h-px bg-gradient-to-r from-transparent via-gray-300 dark:via-gray-700 to-transparent"></div>

          {/* 表单区域 */}
          <div className="px-8 py-8">
            {error && (
              <div className="mb-6 p-4 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-600 dark:text-red-400 text-sm rounded-xl flex items-center gap-2 animate-shake">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="12" cy="12" r="10"/>
                  <line x1="12" y1="8" x2="12" y2="12"/>
                  <line x1="12" y1="16" x2="12.01" y2="16"/>
                </svg>
                {error}
              </div>
            )}
            {message && (
              <div className="mb-6 p-4 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 text-green-600 dark:text-green-400 text-sm rounded-xl flex items-center gap-2">
                <Check size={16} />
                {message}
              </div>
            )}

            {/* 登录表单 */}
            {view === 'login' && (
              <form onSubmit={handleLogin} className="space-y-5">
                {/* 邮箱输入 */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    邮箱地址
                  </label>
                  <div className="relative group">
                    <Mail className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 group-focus-within:text-[#5B9BFF] transition-all duration-200" />
                    <input
                      type="email"
                      required
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      className="w-full pl-12 pr-4 py-3.5 bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#5B9BFF]/50 focus:border-[#5B9BFF] transition-all duration-200 text-gray-900 dark:text-white placeholder-gray-400 hover:border-gray-300 dark:hover:border-gray-600"
                      placeholder="请输入QQ邮箱"
                    />
                    {/* 输入框底部光效 */}
                    <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0.5 bg-[#5B9BFF] group-focus-within:w-full transition-all duration-300 rounded-full"></div>
                  </div>
                </div>

                {/* 验证码输入 */}
                <div className="space-y-2">
                  <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                    验证码
                  </label>
                  <div className="flex gap-3">
                    <div className="relative group flex-1">
                      <Lock className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-gray-400 group-focus-within:text-[#5B9BFF] transition-all duration-200" />
                      <input
                        type="text"
                        required
                        value={code}
                        onChange={(e) => setCode(e.target.value)}
                        className="w-full pl-12 pr-4 py-3.5 bg-gray-50/50 dark:bg-white/5 border border-gray-200 dark:border-gray-700 rounded-xl focus:outline-none focus:ring-2 focus:ring-[#5B9BFF]/50 focus:border-[#5B9BFF] transition-all duration-200 text-gray-900 dark:text-white placeholder-gray-400 hover:border-gray-300 dark:hover:border-gray-600"
                        placeholder="请输入验证码"
                        maxLength={6}
                      />
                      {/* 输入框底部光效 */}
                      <div className="absolute bottom-0 left-1/2 -translate-x-1/2 w-0 h-0.5 bg-[#5B9BFF] group-focus-within:w-full transition-all duration-300 rounded-full"></div>
                    </div>
                    <button
                      type="button"
                      onClick={handleSendCode}
                      disabled={countdown > 0 || loading}
                      className="px-6 py-3.5 bg-[#5B9BFF] hover:bg-[#4A8AE6] active:bg-[#3D7AD6] disabled:bg-[#B3D4FF] disabled:opacity-60 text-white text-sm font-semibold rounded-xl transition-all duration-200 disabled:cursor-not-allowed whitespace-nowrap shadow-lg shadow-[#5B9BFF]/25 hover:shadow-[#5B9BFF]/40 active:shadow-[#5B9BFF]/15 hover:-translate-y-0.5 active:translate-y-0 disabled:transform-none border border-[#4A8AE6]/30"
                    >
                      {countdown > 0 ? `${countdown}s` : '发送验证码'}
                    </button>
                  </div>
                </div>

                {/* 登录按钮 */}
                <button
                  type="submit"
                  disabled={loading}
                  className="w-full py-4 bg-[#5B9BFF] hover:bg-[#4A8AE6] active:bg-[#3D7AD6] disabled:bg-[#B3D4FF] disabled:opacity-60 text-white font-semibold rounded-xl transition-all duration-200 disabled:cursor-not-allowed mt-6 shadow-lg shadow-[#5B9BFF]/30 hover:shadow-[#5B9BFF]/50 active:shadow-[#5B9BFF]/20 hover:-translate-y-0.5 active:translate-y-0 disabled:transform-none border border-[#4A8AE6]/30 flex items-center justify-center gap-2 group relative overflow-hidden"
                >
                  {/* 按钮光效背景 */}
                  <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/20 to-transparent -translate-x-full group-hover:translate-x-full transition-transform duration-700"></div>
                  {loading ? (
                    <>
                      <svg className="animate-spin w-5 h-5 relative z-10" viewBox="0 0 24 24">
                        <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                        <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                      </svg>
                      <span className="relative z-10">登录中...</span>
                    </>
                  ) : (
                    <>
                      <span className="relative z-10">登录</span>
                      <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform duration-200 relative z-10" />
                    </>
                  )}
                </button>
              </form>
            )}
          </div>

          {/* 底部装饰 */}
          <div className="px-8 pb-6">
            <div className="h-px bg-gradient-to-r from-transparent via-gray-300 dark:via-gray-700 to-transparent mb-4"></div>
            <p className="text-center text-xs text-gray-500 dark:text-gray-500">
              登录即表示您同意我们的
              <a href="#" className="text-[#5B9BFF] hover:text-[#4A8AE6] hover:underline transition-colors">服务条款</a>
              和
              <a href="#" className="text-[#5B9BFF] hover:text-[#4A8AE6] hover:underline transition-colors">隐私政策</a>
            </p>
          </div>
        </div>
      </div>

      {/* 添加动画样式 */}
      <style>{`
        @keyframes shake {
          0%, 100% { transform: translateX(0); }
          10%, 30%, 50%, 70%, 90% { transform: translateX(-4px); }
          20%, 40%, 60%, 80% { transform: translateX(4px); }
        }
        .animate-shake {
          animation: shake 0.5s ease-in-out;
        }
      `}</style>
    </div>
  );
};

export default Auth;
