import React, { useEffect, useRef } from 'react';
import { EmotionType, getEmotionColor, getEmotionAnimationSpeed } from '../utils/emotionDetection';

interface SimonaLogoProps {
  className?: string;
  style?: React.CSSProperties;
  onClick?: () => void;
  autoAnimate?: boolean;
  breathe?: boolean;
  rotate3D?: boolean;  // 新增：3D旋转模式
  color?: string;
  maxScale?: number;
  emotion?: EmotionType;  // 新增：情绪类型
  emotionIntensity?: number;  // 新增：情绪强度 0-1
}

const SimonaLogo: React.FC<SimonaLogoProps> = ({ 
  className = '', 
  style, 
  onClick, 
  autoAnimate = false, 
  breathe = false,
  rotate3D = false,  // 新增默认值
  color = '#D97757',
  maxScale,
  emotion = 'neutral',  // 默认中性情绪
  emotionIntensity = 0.5,  // 默认中等强度
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const requestRef = useRef<number | null>(null);
  
  // Animation state
  const animRef = useRef({
    phase: 0,
    glowIntensity: 0,
    rotationSpeed: 0,
    particlePositions: [] as number[],
    rotationAngle: 0,  // 3D旋转角度
    targetRotationAngle: 0,  // 目标旋转角度（用于平滑过渡）
    currentEmotion: 'neutral' as EmotionType,
    targetEmotion: 'neutral' as EmotionType,
    emotionTransitionProgress: 1,  // 情绪过渡进度 0-1
  });

  useEffect(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Update target emotion when prop changes
    animRef.current.targetEmotion = emotion;
    animRef.current.emotionTransitionProgress = 0;  // Reset transition

    let timestamp = 0;

    const handleResize = () => {
      const rect = container.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.max(1, Math.round(rect.width));
      const height = Math.max(1, Math.round(rect.height));
      
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
    };

    const animate = (time: number) => {
      requestRef.current = requestAnimationFrame(animate);
      timestamp = time;
      
      const rect = container.getBoundingClientRect();
      const cx = rect.width / 2;
      const cy = rect.height / 2;
      const minDim = Math.min(rect.width, rect.height);
      const scale = (minDim / 200) * (maxScale || 1);

      // Clear canvas
      ctx.clearRect(0, 0, rect.width, rect.height);

      ctx.save();
      ctx.translate(cx, cy);
      ctx.scale(scale * 100, scale * 100);

      // Update animation
      const anim = animRef.current;
      
      // 情绪过渡逻辑
      if (anim.targetEmotion !== anim.currentEmotion) {
        anim.emotionTransitionProgress += 0.05;
        if (anim.emotionTransitionProgress >= 1) {
          anim.currentEmotion = anim.targetEmotion;
          anim.emotionTransitionProgress = 1;
        }
      }
      
      // 根据情绪调整动画速度
      const emotionSpeed = getEmotionAnimationSpeed(anim.currentEmotion);
      const speedMultiplier = emotionSpeed * (0.8 + emotionIntensity * 0.4);  // 情绪强度影响速度
      
      anim.phase += autoAnimate ? 0.06 * speedMultiplier : (breathe ? 0.025 * speedMultiplier : 0.008 * speedMultiplier);
      anim.glowIntensity = Math.sin(anim.phase) * 0.3 + 0.7;
      anim.rotationSpeed = autoAnimate ? 0.015 * speedMultiplier : 0.003 * speedMultiplier;

      // 3D rotation logic with smooth transition
      anim.targetRotationAngle = rotate3D ? anim.phase * 2 * speedMultiplier : 0;  // 对话时持续旋转，否则回到0
      // Smooth interpolation (lerp) for natural transition
      anim.rotationAngle += (anim.targetRotationAngle - anim.rotationAngle) * 0.08;

      const pulseScale = Math.sin(anim.phase * 0.8) * 0.03 + 1;

      // 获取当前情绪颜色（带过渡）
      let emotionColor = getEmotionColor(anim.currentEmotion);
      if (anim.emotionTransitionProgress < 1) {
        // 简单过渡：可以扩展为颜色混合
        emotionColor = getEmotionColor(anim.currentEmotion);
      }
      
      // 将十六进制颜色转换为 RGB
      const hexToRgb = (hex: string) => {
        const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
        return result ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16)
        } : { r: 100, g: 180, b: 255 };
      };
      
      const rgb = hexToRgb(emotionColor);
      const baseColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
      const lightColor = `rgb(${Math.min(255, rgb.r + 40)}, ${Math.min(255, rgb.g + 40)}, ${Math.min(255, rgb.b + 40)})`;
      const darkColor = `rgb(${Math.max(0, rgb.r - 40)}, ${Math.max(0, rgb.g - 40)}, ${Math.max(0, rgb.b - 40)})`;

      // === Draw ambient background glow ===
      const ambientGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 1.2);
      ambientGlow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.08 * anim.glowIntensity})`);
      ambientGlow.addColorStop(0.5, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.03 * anim.glowIntensity})`);
      ambientGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = ambientGlow;
      ctx.beginPath();
      ctx.arc(0, 0, 1.2, 0, Math.PI * 2);
      ctx.fill();

      // === Draw elegant wing shape ===
      const lineWidth = 0.14;  // 线条宽度
      const wingSpan = 0.85;  // 翅膀展开宽度
      const wingHeight = 0.55;  // 翅膀高度
      
      // Apply 3D rotation transform
      ctx.save();
      if (anim.rotationAngle !== 0) {
        // 3D rotation around Y axis (simulated by scaling X)
        const cosAngle = Math.cos(anim.rotationAngle);
        const scaleX = Math.abs(cosAngle);  // 使用绝对值避免翻转
        ctx.scale(scaleX, 1);
        
        // Add perspective effect - make it look more 3D
        if (scaleX < 0.3) {
          // When nearly edge-on, add slight transparency for depth
          ctx.globalAlpha = 0.6 + scaleX * 0.4;
        }
      }
      
      // Layer 1: Outer soft glow (6 layers for richer effect)
      for (let i = 6; i >= 0; i--) {
        const glowWidth = lineWidth + i * 0.09;
        const alpha = (0.15 - i * 0.02) * anim.glowIntensity;
        
        ctx.strokeStyle = `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${alpha})`;
        ctx.lineWidth = glowWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        
        ctx.beginPath();
        drawWings(ctx, wingSpan, wingHeight, pulseScale);
        ctx.stroke();
      }

      // Layer 2: Main gradient stroke with feather-like texture
      const gradient = ctx.createLinearGradient(
        -wingSpan * 1.5, -wingHeight,
        wingSpan * 1.5, wingHeight
      );
      gradient.addColorStop(0, darkColor);
      gradient.addColorStop(0.2, baseColor);
      gradient.addColorStop(0.4, lightColor);
      gradient.addColorStop(0.5, `rgba(255, 255, 255, ${0.8 * anim.glowIntensity})`);  // Center highlight
      gradient.addColorStop(0.6, lightColor);
      gradient.addColorStop(0.8, baseColor);
      gradient.addColorStop(1, darkColor);
      
      ctx.strokeStyle = gradient;
      ctx.lineWidth = lineWidth;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      
      ctx.beginPath();
      drawWings(ctx, wingSpan, wingHeight, pulseScale);
      ctx.stroke();

      // Layer 3: Inner highlight (creates elegant 3D effect)
      ctx.strokeStyle = `rgba(255, 255, 255, ${0.6 * anim.glowIntensity})`;
      ctx.lineWidth = lineWidth * 0.4;
      
      ctx.beginPath();
      drawWings(ctx, wingSpan * 0.97, wingHeight * 0.97, pulseScale);
      ctx.stroke();

      // Layer 4: Edge definition with shadow
      ctx.strokeStyle = `rgba(${Math.max(0, rgb.r - 70)}, ${Math.max(0, rgb.g - 70)}, ${Math.max(0, rgb.b - 70)}, ${0.35 * anim.glowIntensity})`;
      ctx.lineWidth = lineWidth * 1.15;
      ctx.globalCompositeOperation = 'destination-over';
      
      ctx.beginPath();
      drawWings(ctx, wingSpan, wingHeight, pulseScale);
      ctx.stroke();
      
      ctx.globalCompositeOperation = 'source-over';

      // Layer 5: Core bright line for definition
      ctx.strokeStyle = `rgba(${Math.min(255, rgb.r + 90)}, ${Math.min(255, rgb.g + 90)}, ${Math.min(255, rgb.b + 90)}, ${0.7 * anim.glowIntensity})`;
      ctx.lineWidth = lineWidth * 0.18;
      
      ctx.beginPath();
      drawWings(ctx, wingSpan, wingHeight, pulseScale);
      ctx.stroke();

      // === Animated flow particles along wings ===
      const baseParticleCount = autoAnimate ? 16 : (breathe ? 12 : 10);
      const particleCount = Math.floor(baseParticleCount * (0.8 + emotionIntensity * 0.6));  // 情绪强度影响粒子数量
      
      for (let i = 0; i < particleCount; i++) {
        const t = ((anim.phase * 0.2 + i / particleCount) % 1);
        const pos = getWingPoint(t, wingSpan, wingHeight, pulseScale);
        const particleSize = 0.02 + Math.sin(anim.phase * 1.8 + i * 0.9) * 0.008;
        const particleAlpha = 0.75 + Math.sin(anim.phase + i * 1.2) * 0.25;
        
        // Particle outer glow - larger and softer
        const outerGlow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, particleSize * 8);
        outerGlow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.55 * particleAlpha})`);
        outerGlow.addColorStop(0.3, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.25 * particleAlpha})`);
        outerGlow.addColorStop(1, 'transparent');
        ctx.fillStyle = outerGlow;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, particleSize * 8, 0, Math.PI * 2);
        ctx.fill();
        
        // Particle mid glow
        const midGlow = ctx.createRadialGradient(pos.x, pos.y, 0, pos.x, pos.y, particleSize * 4);
        midGlow.addColorStop(0, `rgba(${Math.min(255, rgb.r + 60)}, ${Math.min(255, rgb.g + 60)}, ${Math.min(255, rgb.b + 60)}, ${0.85 * particleAlpha})`);
        midGlow.addColorStop(1, 'transparent');
        ctx.fillStyle = midGlow;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, particleSize * 4, 0, Math.PI * 2);
        ctx.fill();
        
        // Particle core with sparkle effect
        ctx.fillStyle = `rgba(255, 255, 255, ${particleAlpha})`;
        ctx.beginPath();
        ctx.arc(pos.x, pos.y, particleSize, 0, Math.PI * 2);
        ctx.fill();
      }

      // === Elegant center intersection glow (where wings meet) ===
      const centerGlow = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.35);
      centerGlow.addColorStop(0, `rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, ${0.2 * anim.glowIntensity})`);
      centerGlow.addColorStop(0.4, `rgba(${Math.min(255, rgb.r + 30)}, ${Math.min(255, rgb.g + 30)}, ${Math.min(255, rgb.b + 30)}, ${0.1 * anim.glowIntensity})`);
      centerGlow.addColorStop(1, 'transparent');
      ctx.fillStyle = centerGlow;
      ctx.beginPath();
      ctx.arc(0, 0, 0.35, 0, Math.PI * 2);
      ctx.fill();

      // === Wing tip accents (feather endpoints) ===
      const leftTip = { x: -wingSpan * 0.85, y: -wingHeight * 0.3 };
      const rightTip = { x: wingSpan * 0.85, y: -wingHeight * 0.3 };
      const bottomCenter = { x: 0, y: wingHeight * 0.6 };
      
      [leftTip, rightTip, bottomCenter].forEach((point, idx) => {
        const accentGlow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, 0.2);
        accentGlow.addColorStop(0, `rgba(${Math.min(255, rgb.r + 40)}, ${Math.min(255, rgb.g + 40)}, ${Math.min(255, rgb.b + 40)}, ${0.12 * anim.glowIntensity})`);
        accentGlow.addColorStop(1, 'transparent');
        ctx.fillStyle = accentGlow;
        ctx.beginPath();
        ctx.arc(point.x, point.y, 0.2, 0, Math.PI * 2);
        ctx.fill();
      });

      // Restore 3D rotation transform
      ctx.restore();

      ctx.restore();
    };

    handleResize();
    const resizeAfterPaint = requestAnimationFrame(handleResize);

    const resizeObserver = typeof ResizeObserver !== 'undefined'
      ? new ResizeObserver(() => handleResize())
      : null;
    resizeObserver?.observe(container);

    window.addEventListener('resize', handleResize);
    
    requestRef.current = requestAnimationFrame(animate);

    return () => {
      window.removeEventListener('resize', handleResize);
      resizeObserver?.disconnect();
      cancelAnimationFrame(resizeAfterPaint);
      if (requestRef.current) cancelAnimationFrame(requestRef.current);
    };
  }, [autoAnimate, breathe, maxScale, emotion, emotionIntensity]);  // 添加情绪相关依赖

  return (
    <div 
      ref={containerRef} 
      className={className} 
      style={{ 
        width: '100%', 
        height: '100%',
        borderRadius: '50%',
        overflow: 'hidden',
        ...style 
      }} 
      onClick={onClick}
    >
      <canvas 
        ref={canvasRef} 
        className="block touch-none"
        style={{ width: '100%', height: '100%', display: 'block' }} 
      />
    </div>
  );
};

// Helper function to draw elegant wing shape (symmetrical wings spreading from center)
function drawWings(ctx: CanvasRenderingContext2D, span: number, height: number, scale: number = 1) {
  const s = span * scale;
  const h = height * scale;
  
  // Draw left wing - graceful curve spreading outward
  ctx.moveTo(0, 0);
  
  // Left wing upper arc
  ctx.bezierCurveTo(
    -s * 0.3, -h * 0.8,   // Control point 1
    -s * 0.7, -h * 0.9,   // Control point 2
    -s, -h * 0.4          // End point (wing tip)
  );
  
  // Left wing lower arc back to center
  ctx.bezierCurveTo(
    -s * 0.6, h * 0.3,    // Control point 1
    -s * 0.2, h * 0.5,    // Control point 2
    0, 0                  // Back to center
  );
  
  ctx.closePath();
  
  // Draw right wing - mirror of left
  ctx.moveTo(0, 0);
  
  // Right wing upper arc
  ctx.bezierCurveTo(
    s * 0.3, -h * 0.8,    // Control point 1
    s * 0.7, -h * 0.9,    // Control point 2
    s, -h * 0.4           // End point (wing tip)
  );
  
  // Right wing lower arc back to center
  ctx.bezierCurveTo(
    s * 0.6, h * 0.3,     // Control point 1
    s * 0.2, h * 0.5,     // Control point 2
    0, 0                  // Back to center
  );
  
  ctx.closePath();
}

// Helper function to get point on wing path at parameter t (0-1)
function getWingPoint(t: number, span: number, height: number, scale: number = 1) {
  const s = span * scale;
  const h = height * scale;
  
  let x, y;
  if (t < 0.5) {
    // Left wing (0-0.5)
    const lt = t * 2; // Normalize to 0-1
    if (lt < 0.5) {
      // Upper arc of left wing
      const u = lt * 2; // 0-1 along upper curve
      x = -s * (0.3 * u + 0.7 * u * u - 0.3 * u * u * u);
      y = -h * (0.8 * u + 0.1 * u * u - 0.5 * u * u * u);
    } else {
      // Lower arc of left wing
      const u = (lt - 0.5) * 2; // 0-1 along lower curve
      x = -s * (0.6 * (1-u) + 0.2 * u);
      y = h * (0.3 * (1-u) + 0.5 * u);
    }
  } else {
    // Right wing (0.5-1)
    const rt = (t - 0.5) * 2; // Normalize to 0-1
    if (rt < 0.5) {
      // Upper arc of right wing
      const u = rt * 2; // 0-1 along upper curve
      x = s * (0.3 * u + 0.7 * u * u - 0.3 * u * u * u);
      y = -h * (0.8 * u + 0.1 * u * u - 0.5 * u * u * u);
    } else {
      // Lower arc of right wing
      const u = (rt - 0.5) * 2; // 0-1 along lower curve
      x = s * (0.6 * (1-u) + 0.2 * u);
      y = h * (0.3 * (1-u) + 0.5 * u);
    }
  }
  
  return { x, y };
}

export default SimonaLogo;
