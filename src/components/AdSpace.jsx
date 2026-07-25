import React, { useState, useEffect } from 'react';
import { Sparkles, ArrowRight, Bot, Cpu } from 'lucide-react';

const PROMO_SLIDES = [
    {
        lang: "ES",
        flag: "🇲🇽",
        tag: "CURSOS 100% GRATIS CON IA",
        title: "¿Quieres entender la tecnología a tu alrededor?",
        subtitle: "¡Inicia gratis hoy con IA Generativa & STEMBot Socrático! ⚡",
        cta: "Aprender Gratis",
        tagStyle: "bg-cyan-500/15 text-cyan-300 border-cyan-500/30"
    },
    {
        lang: "EN",
        flag: "🇺🇸",
        tag: "100% FREE AI COURSES",
        title: "Want to know about the Tech around you?",
        subtitle: "Start now all free courses powered by GenAI & STEMBot! ⚡",
        cta: "Start Learning Free",
        tagStyle: "bg-blue-500/15 text-blue-300 border-blue-500/30"
    },
    {
        lang: "ES",
        flag: "🇲🇽",
        tag: "230+ MÓDULOS INTERACTIVOS",
        title: "Domina IA, Semiconductores y Robótica",
        subtitle: "Aprende habilidades del futuro con simulaciones y micro-credenciales 🚀",
        cta: "Explorar Módulos",
        tagStyle: "bg-emerald-500/15 text-emerald-300 border-emerald-500/30"
    },
    {
        lang: "EN",
        flag: "🇺🇸",
        tag: "NEXT-GEN STEM EDUCATION",
        title: "Empower Your Digital Future",
        subtitle: "Zero cost, unlimited learning. From New York to Mexico & LATAM 🌎",
        cta: "Join JóvenesSTEM",
        tagStyle: "bg-purple-500/15 text-purple-300 border-purple-500/30"
    }
];

const AdSpace = () => {
    const [currentSlide, setCurrentSlide] = useState(0);
    const [isFading, setIsFading] = useState(false);

    useEffect(() => {
        const interval = setInterval(() => {
            setIsFading(true);
            setTimeout(() => {
                setCurrentSlide((prev) => (prev + 1) % PROMO_SLIDES.length);
                setIsFading(false);
            }, 350);
        }, 5500);
        return () => clearInterval(interval);
    }, []);

    const slide = PROMO_SLIDES[currentSlide];

    return (
        <div className="w-full max-w-md my-6 px-2 relative z-20">
            <a
                href="https://yepzhi.com/jsweb/"
                target="_blank"
                rel="noopener noreferrer"
                className="group block relative overflow-hidden rounded-2xl bg-slate-950/85 border border-white/15 p-4 shadow-2xl backdrop-blur-2xl transition-all duration-500 hover:border-cyan-400/40 hover:shadow-[0_0_35px_rgba(39,126,255,0.25)]"
            >
                {/* Tech Dot Grid Texture */}
                <div className="absolute inset-0 bg-[radial-gradient(#38bdf8_1px,transparent_1px)] [background-size:16px_16px] opacity-10 pointer-events-none"></div>

                {/* Animated Ambient Glow */}
                <div className="absolute -top-10 -right-10 w-32 h-32 bg-cyan-500/20 rounded-full blur-3xl group-hover:bg-blue-500/30 transition-all duration-700 pointer-events-none"></div>

                {/* Progress Bar Header */}
                <div className="absolute top-0 left-0 right-0 h-0.5 bg-white/10 overflow-hidden">
                    <div
                        key={currentSlide}
                        className="h-full bg-gradient-to-r from-[#277eff] via-[#00d2ff] to-[#00a896]"
                        style={{
                            width: '100%',
                            transition: 'width 5.5s linear'
                        }}
                    />
                </div>

                {/* Top Bar: Glued JóvenesSTEM® Web Brand & Language Toggle */}
                <div className="flex items-center justify-between mb-3.5 relative z-10 pt-1">
                    {/* Glued Brand Logo matching yepzhi.com */}
                    <div className="flex items-baseline font-black text-sm tracking-tight select-none">
                        <span className="bg-gradient-to-r from-[#277eff] via-[#1a9dff] to-[#00a896] bg-clip-text text-transparent font-extrabold">
                            jóvenes
                        </span>
                        <span className="text-white font-black tracking-tight">
                            STEM
                        </span>
                        <sup className="text-[8px] font-bold text-cyan-400 align-super leading-none ml-0.5">&reg;</sup>
                        <span className="text-[9px] text-white font-extrabold bg-gradient-to-r from-[#277eff] to-[#00d2ff] px-1.5 py-0.5 rounded-md uppercase tracking-wider ml-1.5 shadow-sm">
                            Web
                        </span>
                    </div>

                    {/* Indicators & Flag */}
                    <div className="flex items-center gap-2">
                        <span className="text-[10px] font-bold text-gray-300 bg-white/10 px-1.5 py-0.5 rounded-md flex items-center gap-1 border border-white/10">
                            <span>{slide.flag}</span>
                            <span className="text-[9px] text-gray-300 font-semibold">{slide.lang}</span>
                        </span>

                        <div className="flex items-center gap-1">
                            {PROMO_SLIDES.map((_, idx) => (
                                <div
                                    key={idx}
                                    className={`h-1.5 rounded-full transition-all duration-500 ${
                                        idx === currentSlide ? 'w-4 bg-cyan-400' : 'w-1.5 bg-white/20'
                                    }`}
                                />
                            ))}
                        </div>
                    </div>
                </div>

                {/* Dynamic Content with Smooth Transitions */}
                <div
                    className={`relative z-10 transition-all duration-300 transform ${
                        isFading ? 'opacity-0 translate-y-2 scale-[0.98]' : 'opacity-100 translate-y-0 scale-100'
                    }`}
                >
                    <div className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[9px] uppercase font-bold tracking-wider mb-2 border backdrop-blur-md ${slide.tagStyle}`}>
                        <Sparkles size={10} className="animate-spin" style={{ animationDuration: '4s' }} />
                        <span>{slide.tag}</span>
                    </div>

                    <h4 className="text-sm md:text-base font-bold text-white tracking-tight mb-1 leading-snug group-hover:text-cyan-200 transition-colors">
                        {slide.title}
                    </h4>

                    <p className="text-xs text-gray-300 font-normal leading-relaxed mb-3">
                        {slide.subtitle}
                    </p>

                    {/* Bottom CTA Bar */}
                    <div className="flex items-center justify-between pt-2.5 border-t border-white/10">
                        <span className="text-[10px] text-gray-400 font-medium flex items-center gap-1">
                            <Cpu size={12} className="text-cyan-400" />
                            <span>AI-Powered Learning Platform</span>
                        </span>

                        <div className="flex items-center gap-1.5 text-xs font-bold text-cyan-400 group-hover:text-cyan-300 transition-colors">
                            <span>{slide.cta}</span>
                            <ArrowRight size={14} className="transform group-hover:translate-x-1 transition-transform" />
                        </div>
                    </div>
                </div>
            </a>
        </div>
    );
};

export default AdSpace;
