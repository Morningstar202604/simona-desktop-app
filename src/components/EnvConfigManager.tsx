import React, { useState, useEffect } from 'react';
import { Download, Upload, Save, RefreshCw, AlertCircle, CheckCircle } from 'lucide-react';

// 声明 electronAPI 类型
declare global {
    interface Window {
        electronAPI?: {
            envConfigLoad?: () => Promise<any>;
            envConfigSave?: (config: any) => Promise<{ success: boolean }>;
            envConfigExport?: () => Promise<{ success: boolean; path?: string; reason?: string }>;
            envConfigImport?: () => Promise<{ success: boolean; config?: any; error?: string; reason?: string }>;
            envConfigBackup?: () => Promise<{ success: boolean; path?: string }>;
            envConfigCheckMachine?: () => Promise<{ isNewMachine: boolean }>;
        };
    }
}

const EnvConfigManager = () => {
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [message, setMessage] = useState({ type: '', text: '' });
    const [showAdvanced, setShowAdvanced] = useState(false);

    useEffect(() => {
        loadConfig();
    }, []);

    const loadConfig = async () => {
        try {
            setLoading(true);
            if (window.electronAPI?.envConfigLoad) {
                const loadedConfig = await window.electronAPI.envConfigLoad();
                setConfig(loadedConfig);
            }
        } catch (error) {
            showMessage('error', '加载配置失败: ' + error.message);
        } finally {
            setLoading(false);
        }
    };

    const saveConfig = async () => {
        try {
            setSaving(true);
            if (window.electronAPI?.envConfigSave) {
                const result = await window.electronAPI.envConfigSave(config);
                if (result.success) {
                    showMessage('success', '配置保存成功');
                } else {
                    showMessage('error', '配置保存失败');
                }
            }
        } catch (error) {
            showMessage('error', '保存配置失败: ' + error.message);
        } finally {
            setSaving(false);
        }
    };

    const exportConfig = async () => {
        try {
            if (window.electronAPI?.envConfigExport) {
                const result = await window.electronAPI.envConfigExport();
                if (result.success) {
                    showMessage('success', `配置已导出到: ${result.path}`);
                } else if (result.reason !== 'canceled') {
                    showMessage('error', '导出配置失败');
                }
            }
        } catch (error) {
            showMessage('error', '导出配置失败: ' + error.message);
        }
    };

    const importConfig = async () => {
        try {
            if (window.electronAPI?.envConfigImport) {
                const result = await window.electronAPI.envConfigImport();
                if (result.success) {
                    setConfig(result.config);
                    showMessage('success', '配置导入成功');
                } else if (result.reason !== 'canceled') {
                    showMessage('error', result.error || '导入配置失败');
                }
            }
        } catch (error) {
            showMessage('error', '导入配置失败: ' + error.message);
        }
    };

    const createBackup = async () => {
        try {
            if (window.electronAPI?.envConfigBackup) {
                const result = await window.electronAPI.envConfigBackup();
                if (result.success) {
                    showMessage('success', `配置备份已创建: ${result.path}`);
                } else {
                    showMessage('error', '创建备份失败');
                }
            }
        } catch (error) {
            showMessage('error', '创建备份失败: ' + error.message);
        }
    };

    const checkMachine = async () => {
        try {
            if (window.electronAPI?.envConfigCheckMachine) {
                const result = await window.electronAPI.envConfigCheckMachine();
                if (result.isNewMachine) {
                    showMessage('info', '检测到新机器，建议导入之前的配置');
                } else {
                    showMessage('info', '当前机器配置正常');
                }
            }
        } catch (error) {
            showMessage('error', '检查机器状态失败: ' + error.message);
        }
    };

    const showMessage = (type, text) => {
        setMessage({ type, text });
        setTimeout(() => setMessage({ type: '', text: '' }), 5000);
    };

    const handleConfigChange = (key, value) => {
        setConfig(prev => ({
            ...prev,
            [key]: value
        }));
    };

    if (loading) {
        return (
            <div className="flex items-center justify-center p-8">
                <RefreshCw className="animate-spin text-blue-500" size={24} />
                <span className="ml-2 text-gray-600">加载配置...</span>
            </div>
        );
    }

    return (
        <div className="max-w-4xl mx-auto p-6">
            <div className="mb-6">
                <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                    环境配置管理
                </h2>
                <p className="text-gray-600 dark:text-gray-400">
                    管理 Simona Desktop 的环境配置，支持换机时的配置迁移
                </p>
            </div>

            {/* Message Display */}
            {message.text && (
                <div className={`mb-6 p-4 rounded-lg border ${
                    message.type === 'success' ? 'bg-green-50 border-green-200 text-green-800' :
                    message.type === 'error' ? 'bg-red-50 border-red-200 text-red-800' :
                    'bg-blue-50 border-blue-200 text-blue-800'
                }`}>
                    <div className="flex items-center">
                        {message.type === 'success' && <CheckCircle size={16} className="mr-2" />}
                        {message.type === 'error' && <AlertCircle size={16} className="mr-2" />}
                        {message.text}
                    </div>
                </div>
            )}

            {/* Action Buttons */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
                <button
                    onClick={saveConfig}
                    disabled={saving}
                    className="flex items-center justify-center px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
                >
                    <Save size={16} className="mr-2" />
                    {saving ? '保存中...' : '保存配置'}
                </button>
                
                <button
                    onClick={exportConfig}
                    className="flex items-center justify-center px-4 py-2 bg-green-600 text-white rounded-lg hover:bg-green-700 transition-colors"
                >
                    <Download size={16} className="mr-2" />
                    导出配置
                </button>
                
                <button
                    onClick={importConfig}
                    className="flex items-center justify-center px-4 py-2 bg-purple-600 text-white rounded-lg hover:bg-purple-700 transition-colors"
                >
                    <Upload size={16} className="mr-2" />
                    导入配置
                </button>
                
                <button
                    onClick={createBackup}
                    className="flex items-center justify-center px-4 py-2 bg-orange-600 text-white rounded-lg hover:bg-orange-700 transition-colors"
                >
                    <RefreshCw size={16} className="mr-2" />
                    创建备份
                </button>
            </div>

            <button
                onClick={checkMachine}
                className="w-full mb-6 px-4 py-2 bg-gray-600 text-white rounded-lg hover:bg-gray-700 transition-colors"
            >
                检查机器状态
            </button>

            {/* Configuration Form */}
            {config && (
                <div className="bg-white dark:bg-gray-800 rounded-lg shadow-sm border border-gray-200 dark:border-gray-700">
                    <div className="p-6 border-b border-gray-200 dark:border-gray-700">
                        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                            基础配置
                        </h3>
                    </div>
                    
                    <div className="p-6 space-y-4">
                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                用户模式
                            </label>
                            <select
                                value={config.user_mode || 'selfhosted'}
                                onChange={(e) => handleConfigChange('user_mode', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                            >
                                <option value="selfhosted">自部署模式</option>
                                <option value="clawparrot">Clawparrot 模式</option>
                            </select>
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                API Key
                            </label>
                            <input
                                type="password"
                                value={config.SIMONA_API_KEY || ''}
                                onChange={(e) => handleConfigChange('SIMONA_API_KEY', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                placeholder="输入您的 API Key"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                Base URL
                            </label>
                            <input
                                type="text"
                                value={config.SIMONA_BASE_URL || ''}
                                onChange={(e) => handleConfigChange('SIMONA_BASE_URL', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                placeholder="https://api.simona.com"
                            />
                        </div>

                        <div>
                            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                默认模型
                            </label>
                            <input
                                type="text"
                                value={config.SIMONA_MODEL || 'simona-sonnet-4-6'}
                                onChange={(e) => handleConfigChange('SIMONA_MODEL', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                            />
                        </div>
                    </div>

                    {/* Advanced Settings */}
                    <div className="border-t border-gray-200 dark:border-gray-700">
                        <button
                            onClick={() => setShowAdvanced(!showAdvanced)}
                            className="w-full px-6 py-3 text-left text-sm font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                        >
                            高级设置 {showAdvanced ? '▼' : '▶'}
                        </button>
                        
                        {showAdvanced && (
                            <div className="px-6 pb-6 space-y-4">
                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                        Sonnet 模型
                                    </label>
                                    <input
                                        type="text"
                                        value={config.SIMONA_DEFAULT_SONNET_MODEL || 'simona-sonnet-4-6'}
                                        onChange={(e) => handleConfigChange('SIMONA_DEFAULT_SONNET_MODEL', e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                        Haiku 模型
                                    </label>
                                    <input
                                        type="text"
                                        value={config.SIMONA_DEFAULT_HAIKU_MODEL || 'simona-haiku-4-5-20251001'}
                                        onChange={(e) => handleConfigChange('SIMONA_DEFAULT_HAIKU_MODEL', e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                        Opus 模型
                                    </label>
                                    <input
                                        type="text"
                                        value={config.SIMONA_DEFAULT_OPUS_MODEL || 'simona-opus-4-6'}
                                        onChange={(e) => handleConfigChange('SIMONA_DEFAULT_OPUS_MODEL', e.target.value)}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                    />
                                </div>

                                <div>
                                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
                                        API 超时时间 (毫秒)
                                    </label>
                                    <input
                                        type="number"
                                        value={config.API_TIMEOUT_MS || 300000}
                                        onChange={(e) => handleConfigChange('API_TIMEOUT_MS', parseInt(e.target.value))}
                                        className="w-full px-3 py-2 border border-gray-300 dark:border-gray-600 rounded-md bg-white dark:bg-gray-700 text-gray-900 dark:text-white"
                                    />
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            )}
        </div>
    );
};

export default EnvConfigManager;
