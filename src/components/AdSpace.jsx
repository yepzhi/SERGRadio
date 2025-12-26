import React from 'react';

const AdSpace = () => {
    return (
        <div className="w-full max-w-md bg-white/5 backdrop-blur-sm border border-white/10 rounded-xl p-4 my-8 text-center animate-pulse-slow">
            <p className="text-xs text-gray-500 uppercase tracking-widest mb-1">Advertisement</p>
            <div className="h-24 bg-gradient-to-r from-blue-900/20 to-purple-900/20 rounded-lg flex items-center justify-center border border-dashed border-gray-700">
                <span className="text-gray-600 text-sm font-medium">Ad Space Available</span>
            </div>
        </div>
    );
};

export default AdSpace;
