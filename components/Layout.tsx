import React from 'react';
import { Layout as LayoutIcon, BookOpen, Users, Image, Film, Settings } from 'lucide-react';

interface LayoutProps {
  children: React.ReactNode;
  activeTab?: string;
  onTabChange?: (tab: string) => void;
  title: string;
  onBack?: () => void;
}

export const Layout: React.FC<LayoutProps> = ({ children, activeTab, onTabChange, title, onBack }) => {
  return (
    <div className="flex h-screen bg-gray-900 text-gray-100">
      {/* Sidebar */}
      <aside className="w-20 lg:w-64 bg-gray-950 border-r border-gray-800 flex flex-col transition-all duration-300">
        <div className="p-4 flex items-center justify-center lg:justify-start gap-3 h-16 border-b border-gray-800 cursor-pointer" onClick={onBack}>
          <div className="w-8 h-8 bg-blue-600 rounded-lg flex items-center justify-center shrink-0">
             <Film className="w-5 h-5 text-white" />
          </div>
          <span className="font-bold text-lg hidden lg:block tracking-tight text-white">StoryWeaver</span>
        </div>

        {activeTab && onTabChange && (
          <nav className="flex-1 py-6 px-3 space-y-2">
            <NavItem 
              icon={<BookOpen size={20} />} 
              label="剧本" 
              active={activeTab === 'SCRIPT'} 
              onClick={() => onTabChange('SCRIPT')} 
            />
            <NavItem 
              icon={<Users size={20} />} 
              label="资产" 
              active={activeTab === 'ASSETS'} 
              onClick={() => onTabChange('ASSETS')} 
            />
            <NavItem 
              icon={<LayoutIcon size={20} />} 
              label="分镜" 
              active={activeTab === 'STORYBOARD'} 
              onClick={() => onTabChange('STORYBOARD')} 
            />
             <NavItem 
              icon={<Settings size={20} />} 
              label="导出" 
              active={activeTab === 'EXPORT'} 
              onClick={() => onTabChange('EXPORT')} 
            />
          </nav>
        )}
        
        <div className="p-4 border-t border-gray-800">
          <div className="flex items-center gap-3 text-gray-400 text-sm">
            <div className="w-2 h-2 rounded-full bg-green-500"></div>
            <span className="hidden lg:block">系统在线</span>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <header className="h-16 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-6 shrink-0">
          <h1 className="text-xl font-semibold text-white truncate max-w-xl">{title}</h1>
          <div className="flex items-center gap-4">
            <button className="bg-gray-800 hover:bg-gray-700 text-sm px-4 py-2 rounded-md transition">
              帮助
            </button>
            <div className="w-8 h-8 rounded-full bg-gradient-to-tr from-blue-500 to-purple-500 border-2 border-gray-800"></div>
          </div>
        </header>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto overflow-x-hidden p-6 relative">
          {children}
        </div>
      </main>
    </div>
  );
};

interface NavItemProps {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}

const NavItem: React.FC<NavItemProps> = ({ icon, label, active, onClick }) => (
  <button
    onClick={onClick}
    className={`w-full flex items-center gap-3 px-3 py-3 rounded-lg transition-colors group ${
      active 
        ? 'bg-blue-600/10 text-blue-400 border border-blue-600/20' 
        : 'text-gray-400 hover:bg-gray-800 hover:text-gray-100'
    }`}
  >
    <span className={active ? 'text-blue-400' : 'text-gray-500 group-hover:text-gray-300'}>{icon}</span>
    <span className="font-medium hidden lg:block">{label}</span>
  </button>
);