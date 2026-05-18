"use client";
import React, { useState } from "react";
import SimliOpenAI from "./SimliOpenAI";

interface avatarSettings {
  name: string;
  openai_voice: "alloy" | "ash" | "ballad" | "coral" | "echo" | "sage" | "shimmer" | "verse";
  openai_model: string;
  simli_faceid: string;
  initialPrompt: string;
}

// Customize your avatar here
const avatar: avatarSettings = {
  name: "Tina",
  openai_voice: "shimmer", // Set to OpenAI's premium female voice (Google TTS proxy defaults to a natural female voice)
  openai_model: "gemini-3-flash-preview", // Fully updated to Gemini 3 Flash for maximum speed & lower costs
  simli_faceid: "cace3ef7-a4c4-425d-a8cf-a5358eb0c427", // Tina's official female Face ID
  initialPrompt:
    "You are a helpful female AI assistant named Tina. You are friendly and concise in your responses. Your task is to help users with any questions they might have. Your answers are short and to the point, don't give long answers be brief and straightforward.",
};

const Demo: React.FC = () => {
  const [showDottedFace, setShowDottedFace] = useState(true);

  const onStart = () => {
    console.log("Setting setshowDottedface to false...");
    setShowDottedFace(false);
  };

  const onClose = () => {
    console.log("Setting setshowDottedface to true...");
    setShowDottedFace(true);
  };

  return (
    <div className="bg-black min-h-screen flex flex-col items-center font-abc-repro font-normal text-sm text-white p-8">
      {/* Sleek, glowing brand header */}
      <div className="w-full max-w-6xl flex justify-between items-center mb-6 border-b border-zinc-900 pb-6 animate-fadeIn">
        <div className="flex items-center gap-2">
          <div className="w-3 h-3 bg-indigo-500 rounded-full animate-pulse shadow-[0_0_10px_rgba(99,102,241,0.5)]" />
          <span className="text-sm font-semibold tracking-wider text-zinc-300 font-mono uppercase">
            Gemini Interactive Console
          </span>
        </div>
        <div className="text-xs text-zinc-550 font-mono hidden sm:block">
          Pipeline: Active | Model: {avatar.openai_model}
        </div>
      </div>

      <div className="w-full max-w-6xl mt-2 mb-8 animate-fadeIn">
        <SimliOpenAI
          openai_voice={avatar.openai_voice}
          openai_model={avatar.openai_model}
          simli_faceid={avatar.simli_faceid}
          initialPrompt={avatar.initialPrompt}
          onStart={onStart}
          onClose={onClose}
          showDottedFace={showDottedFace}
          avatarName={avatar.name}
        />
      </div>

      {/* Minimalist professional footer */}
      <div className="w-full max-w-6xl mt-6 pt-6 border-t border-zinc-900 flex flex-col sm:flex-row justify-between items-center gap-2 text-xs text-zinc-600 font-mono animate-fadeIn">
        <span>© 2026 Conversational Agent Interface. All rights reserved.</span>
        <span>Secure Audio-Visual Pipeline (P2P WebRTC)</span>
      </div>
    </div>
  );
};

export default Demo;
