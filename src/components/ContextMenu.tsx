import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';

interface MenuItem {
  label: string;
  separator?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

interface ContextMenuProps {
  x: number;
  y: number;
  items: MenuItem[];
  onClose: () => void;
}

const ContextMenuItem: React.FC<{
  item: MenuItem;
  onHover: () => void;
  isHovered: boolean;
  onItemClick: () => void;
}> = ({ item, onHover, isHovered, onItemClick }) => {
  if (item.separator) return <div className="h-px bg-simona-border my-1" />;
  return (
    <div
      className={`flex items-center px-3 py-1 cursor-pointer transition-colors rounded mx-1 ${
        item.disabled ? 'opacity-40 cursor-not-allowed' : isHovered ? 'bg-simona-hover' : ''
      }`}
      onClick={() => { if (!item.disabled) { item.onClick(); onItemClick(); } }}
      onMouseEnter={onHover}
    >
      <span className="text-[13px] text-simona-text">{item.label}</span>
    </div>
  );
};

const ContextMenuContent: React.FC<ContextMenuProps> = ({ x, y, items, onClose }) => {
  const [hoveredIndex, setHoveredIndex] = useState(-1);
  const menuRef = useRef<HTMLDivElement>(null);
  const [adjustedPosition, setAdjustedPosition] = useState({ x, y });

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as HTMLElement)) { e.preventDefault(); onClose(); }
    };
    const handleKeyDown = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleKeyDown);
    }, 10);
    return () => { clearTimeout(timeoutId); document.removeEventListener('mousedown', handleClickOutside); document.removeEventListener('keydown', handleKeyDown); };
  }, [onClose]);

  useEffect(() => {
    if (menuRef.current) {
      requestAnimationFrame(() => {
        if (!menuRef.current) return;
        const rect = menuRef.current.getBoundingClientRect();
        const vw = window.innerWidth, vh = window.innerHeight;
        let nx = x, ny = y;
        const eh = items.length * 28 + 12, spb = vh - y, spa = y;
        if (spb < eh && spa > eh) ny = y - eh;
        else if (y + eh > vh) ny = vh - eh - 10;
        if (x + 120 > vw) nx = vw - 130;
        if (nx < 10) nx = 10;
        if (ny < 10) ny = 10;
        if (ny + eh > vh) ny = vh - eh - 10;
        setAdjustedPosition({ x: nx, y: ny });
      });
    }
  }, [x, y, items]);

  return createPortal(
    <div ref={menuRef} className="fixed bg-simona-input border border-simona-border rounded-xl shadow-2xl py-1 min-w-[120px] animate-context-menu-in"
      style={{ left: adjustedPosition.x, top: adjustedPosition.y, zIndex: 2147483647 }}>
      {items.map((item, index) => (
        <ContextMenuItem key={index} item={item} onHover={() => setHoveredIndex(index)} isHovered={hoveredIndex === index} onItemClick={onClose} />
      ))}
    </div>, document.body
  );
};

interface GlobalMenuState { isOpen: boolean; x: number; y: number; items: MenuItem[]; onClose: () => void; }
let globalMenu: GlobalMenuState | null = null;
let menuRenderer: ((state: GlobalMenuState | null) => void) | null = null;

export const showContextMenu = (x: number, y: number, items: MenuItem[], onClose: () => void) => {
  globalMenu = { isOpen: true, x, y, items, onClose };
  if (menuRenderer) menuRenderer(globalMenu);
};

export const ContextMenuContainer: React.FC = () => {
  const [menuState, setMenuState] = useState<GlobalMenuState | null>(null);
  useEffect(() => { menuRenderer = setMenuState; return () => { menuRenderer = null; }; }, []);
  if (!menuState?.isOpen) return null;
  return <ContextMenuContent x={menuState.x} y={menuState.y} items={menuState.items}
    onClose={() => { globalMenu = null; if (menuRenderer) menuRenderer(null); }} />;
};

export default ContextMenuContent;
