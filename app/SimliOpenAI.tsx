import IconSparkleLoader from "@/media/IconSparkleLoader";
import { GoogleGenAI } from "@google/genai";
import React, { useCallback, useRef, useState, useEffect } from "react";
import {
    generateSimliSessionToken, SimliClient, SimliSessionRequest,
    generateIceServers, LogLevel
} from "simli-client";
import VideoBox from "./Components/VideoBox";
import DottedFace from "./Components/DottedFace";
import cn from "./utils/TailwindMergeAndClsx";
import { 
    Send, Mic, MicOff, StopCircle, PlayCircle, Loader2, Sparkles, 
    User, Bot, Terminal, AlertCircle, MessageSquare 
} from "lucide-react";

interface SimliOpenAIProps {
    simli_faceid: string;
    openai_voice: "alloy" | "ash" | "ballad" | "coral" | "echo" | "sage" | "shimmer" | "verse";
    openai_model: string;
    initialPrompt: string;
    onStart: () => void;
    onClose: () => void;
    showDottedFace: boolean;
    avatarName?: string;
}

interface ChatMessage {
    id: string;
    sender: "user" | "ai";
    text: string;
    timestamp: Date;
    isStreaming?: boolean;
}

let simliClient: SimliClient | null = null;

const SimliOpenAI: React.FC<SimliOpenAIProps> = ({
    simli_faceid,
    openai_voice,
    openai_model,
    initialPrompt,
    onStart,
    onClose,
    showDottedFace,
    avatarName = "Frank",
}) => {
    // State management
    const [isLoading, setIsLoading] = useState(false);
    const [isAvatarVisible, setIsAvatarVisible] = useState(false);
    const [error, setError] = useState("");
    const [isRecording, setIsRecording] = useState(false);
    const [userMessage, setUserMessage] = useState("...");

    // Chat interface state
    const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
    const [liveInterpreted, setLiveInterpreted] = useState("");
    const [textInput, setTextInput] = useState("");
    const [statusMessage, setStatusMessage] = useState("Offline");
    const [isGenerating, setIsGenerating] = useState(false);

    // Diagnostics terminal logs state
    const [debugLogs, setDebugLogs] = useState<string[]>([]);

    // Refs for preventing stale closures in event listeners
    const isRecordingRef = useRef(false);
    const isGeneratingRef = useRef(false);
    const isMutedRef = useRef(true);
    const playbackEndTimestampRef = useRef<number>(0);
    const isAvatarVisibleRef = useRef(false);

    // Refs for various components and states
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    const geminiClientRef = useRef<GoogleGenAI | null>(null);
    const audioContextRef = useRef<AudioContext | null>(null);
    const recognitionRef = useRef<any>(null);
    const messagesEndRef = useRef<HTMLDivElement>(null);
    const debugEndRef = useRef<HTMLDivElement>(null);

    // Refs for managing audio chunk delay
    const audioChunkQueueRef = useRef<Int16Array[]>([]);
    const isProcessingChunkRef = useRef(false);

    // Refs for sequential TTS sentence queuing to allow unblocked, ultra-smooth chat bubble streaming
    const ttsSentenceQueueRef = useRef<string[]>([]);
    const isSynthesizingRef = useRef(false);

    /**
     * Unified logging utility that logs to both console and the on-screen diagnostics terminal
     */
    const logDebug = useCallback((message: string, type: "info" | "error" | "success" = "info") => {
        const timestamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
        const prefix = `[${timestamp}] [${type.toUpperCase()}]`;
        const logLine = `${prefix} ${message}`;

        // Print to standard console
        if (type === "error") {
            console.error(logLine);
        } else {
            console.log(logLine);
        }

        // Push to on-screen terminal history (limit to last 25 entries to save memory)
        setDebugLogs(prev => [...prev.slice(-24), logLine]);
    }, []);

    // Handle status and welcome message when avatar visibility toggles
    useEffect(() => {
        if (isAvatarVisible) {
            setStatusMessage("Agent online. Speak or type below.");
            setChatHistory([
                {
                    id: "welcome",
                    sender: "ai",
                    text: `Hi! I'm ${avatarName}, your interactive visual avatar powered by Gemini 3 Flash. Feel free to talk using your microphone or type your message in the chat input. Let's get started!`,
                    timestamp: new Date()
                }
            ]);
        } else {
            setStatusMessage("Offline");
            setChatHistory([]);
            setLiveInterpreted("");
        }
    }, [isAvatarVisible, avatarName]);

    // Auto-scroll chat history
    useEffect(() => {
        messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [chatHistory, liveInterpreted]);

    // Auto-scroll diagnostics logs
    useEffect(() => {
        debugEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }, [debugLogs]);

    // Unmount cleanup hook to prevent active lingering WebRTC connections
    useEffect(() => {
        return () => {
            logDebug("SimliOpenAI component unmounting. Starting resource cleanup...", "info");
            stopRecording();
            if (simliClient) {
                logDebug("Stopping active Simli WebRTC client stream...", "info");
                simliClient.stop().catch(err => logDebug(`Error stopping simliClient: ${err.message}`, "error"));
                simliClient = null;
            }
            if (audioContextRef.current) {
                logDebug("Closing audio context output pipeline...", "info");
                audioContextRef.current.close().catch(err => logDebug(`Error closing audioContext: ${err.message}`, "error"));
                audioContextRef.current = null;
            }
        };
    }, []);

    /**
     * Initializes the Simli client with the provided configuration.
     */
    const initializeSimliClient = useCallback(async () => {
        if (videoRef.current && audioRef.current) {
            // Guard: stop any existing client connection to avoid rate limits
            if (simliClient) {
                logDebug("Active Simli Client already exists. Stopping instance first...", "info");
                try {
                    await simliClient.stop();
                } catch (e: any) {
                    logDebug(`Error stopping existing simliClient: ${e.message}`, "error");
                }
                simliClient = null;
            }

            logDebug("Verifying environment setup parameters...", "info");
            const simliApiKey = process.env.NEXT_PUBLIC_SIMLI_API_KEY;
            logDebug(`Simli API Key: ${simliApiKey ? `PRESENT (Length: ${simliApiKey.length} characters)` : "MISSING! Please fill in .env"}`, simliApiKey ? "success" : "error");

            if (!simliApiKey) {
                throw new Error("NEXT_PUBLIC_SIMLI_API_KEY is not defined in your .env file.");
            }

            setStatusMessage("Establishing live feed connection...");

            const SimliConfig: SimliSessionRequest = {
                faceId: simli_faceid || "cace3ef7-a4c4-425d-a8cf-a5358eb0c427",
                handleSilence: true,
                maxSessionLength: 6000, // in seconds
                maxIdleTime: 6000, // in seconds
                model: "fasttalk"
            };
            logDebug(`Avatar Configured - Face ID: ${SimliConfig.faceId} | Mode: FastTalk`, "info");

            let sessionToken = "";
            try {
                logDebug("Requesting session token from Simli...", "info");
                const tokenResponse = await generateSimliSessionToken({
                    apiKey: simliApiKey,
                    config: SimliConfig
                });
                sessionToken = tokenResponse.session_token;
                logDebug(`Session token successfully generated: ${sessionToken.slice(0, 10)}...`, "success");
            } catch (err: any) {
                logDebug(`Session token fetch failed: ${err.message}`, "error");
                throw err;
            }

            let iceServers = [];
            try {
                logDebug("Requesting WebRTC ICE server details...", "info");
                iceServers = await generateIceServers(simliApiKey);
                logDebug(`ICE Servers received successfully (Count: ${iceServers.length})`, "success");
            } catch (err: any) {
                logDebug(`ICE server fetch failed: ${err.message}`, "error");
                throw err;
            }

            logDebug("Instantiating WebRTC Peer SimliClient...", "info");
            simliClient = new SimliClient(
                sessionToken,
                videoRef.current,
                audioRef.current,
                iceServers,
                LogLevel.DEBUG,
                "p2p"
            );

            simliClient.on("start", () => {
                logDebug("WebRTC Media pipeline handshake successful!", "success");
                setStatusMessage("Feed connected. Synchronizing AI brain...");
                // Initialize Gemini client
                initializeGeminiClient();
            });

            simliClient.on("speaking", () => {
                logDebug("Avatar speaking triggered.", "info");
                setStatusMessage("Avatar is speaking...");
            });

            simliClient.on("silent", () => {
                logDebug("Avatar silence triggered.", "info");
                setStatusMessage(isRecordingRef.current ? "Microphone active. Listening..." : "Agent online. Speak or type below.");
            });

            simliClient.on("stop", () => {
                logDebug("WebRTC stream stop command detected.", "info");
                stopRecording();
                if (audioContextRef.current) {
                    audioContextRef.current.close();
                    audioContextRef.current = null;
                }
            });

            logDebug("Activating SimliClient WebRTC start pipeline...", "info");
            await simliClient.start();
            logDebug("SimliClient connection start requested.", "info");
        } else {
            logDebug("Error: Video/Audio element references are null. Re-checking DOM mount.", "error");
        }
    }, [simli_faceid]);

    /**
     * Initializes the Gemini Google Gen AI client.
     */
    const initializeGeminiClient = useCallback(async () => {
        try {
            logDebug("Initializing Gemini Brain client...", "info");
            const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY || process.env.GEMINI_API_KEY;
            
            logDebug(`Gemini API Key: ${apiKey ? `PRESENT (Length: ${apiKey.length} characters)` : "MISSING! Please fill in .env"}`, apiKey ? "success" : "error");
            if (!apiKey) {
                throw new Error("NEXT_PUBLIC_GEMINI_API_KEY or GEMINI_API_KEY is not defined in your environment variables (.env file)");
            }

            // Initialize using the GoogleGenAI SDK
            logDebug("Instantiating GoogleGenAI SDK...", "info");
            geminiClientRef.current = new GoogleGenAI({ apiKey });
            logDebug(`GoogleGenAI successfully connected (Model: ${openai_model})`, "success");

            setIsAvatarVisible(true);
            isAvatarVisibleRef.current = true;
            logDebug("Avatar video feed active. Awaiting user speech...", "info");
        } catch (error: any) {
            logDebug(`Failed to initialize Gemini: ${error.message}`, "error");
            setError(`Failed to initialize Gemini: ${error.message}`);
            setStatusMessage("Gemini failed to initialize");
        }
    }, [initialPrompt, openai_model]);

    /**
     * Handles streaming Gemini completion and sending text to TTS -> Simli
     */
    const handleUserMessage = async (messageText: string) => {
        if (!geminiClientRef.current) {
            logDebug("Cannot handle message: Gemini Client is not initialized.", "error");
            return;
        }

        setIsGenerating(true);
        isGeneratingRef.current = true;
        setStatusMessage("Gemini is thinking...");
        logDebug(`Sending message payload to Gemini: "${messageText.slice(0, 40)}..."`, "info");

        try {
            // Create a new empty AI streaming message in history
            const aiMsgId = (Date.now() + 1).toString();
            setChatHistory(prev => [...prev, {
                id: aiMsgId,
                sender: "ai",
                text: "",
                timestamp: new Date(),
                isStreaming: true
            }]);

            // Call generateContentStream to support real-time chunk-by-chunk text generation
            logDebug("Awaiting Gemini content stream response...", "info");
            const responseStream = await geminiClientRef.current.models.generateContentStream({
                model: openai_model || "gemini-3-flash-preview",
                contents: [messageText],
                config: {
                    systemInstruction: initialPrompt,
                }
            });

            let fullAiResponse = "";
            let sentenceBuffer = "";
            let sentenceCount = 0;

            for await (const chunk of responseStream) {
                const text = chunk.text;
                if (text) {
                    fullAiResponse += text;
                    // Update streaming message in chat log
                    setChatHistory(prev => prev.map(m => m.id === aiMsgId ? { ...m, text: fullAiResponse } : m));

                    sentenceBuffer += text;
                    // Match sentence boundaries (e.g. '.', '!', '?') for smooth TTS streaming
                    const sentenceEndRegex = /[.!?]+/;
                    if (sentenceEndRegex.test(sentenceBuffer)) {
                        const sentences = sentenceBuffer.split(/(?<=[.!?])\s+/);
                        // Store the last potentially incomplete sentence back in the buffer
                        sentenceBuffer = sentences.pop() || "";

                        for (const sentence of sentences) {
                            if (sentence.trim()) {
                                sentenceCount++;
                                logDebug(`Queuing sentence ${sentenceCount} for background TTS: "${sentence.trim().slice(0, 20)}..."`, "info");
                                ttsSentenceQueueRef.current.push(sentence.trim());
                                processNextTtsSentence();
                            }
                        }
                    }
                }
            }

            // Speak any remaining text left in the buffer
            if (sentenceBuffer.trim()) {
                sentenceCount++;
                logDebug(`Queuing final sentence ${sentenceCount} for background TTS: "${sentenceBuffer.trim().slice(0, 20)}..."`, "info");
                ttsSentenceQueueRef.current.push(sentenceBuffer.trim());
                processNextTtsSentence();
            }

            // Set streaming status to false for this message
            setChatHistory(prev => prev.map(m => m.id === aiMsgId ? { ...m, isStreaming: false } : m));
            logDebug(`Gemini stream successfully rendered. Total sentences generated: ${sentenceCount}`, "success");
            setStatusMessage(isRecordingRef.current ? "Microphone active. Listening..." : "Agent online. Speak or type below.");

        } catch (err: any) {
            logDebug(`Gemini stream generation failed: ${err.message}`, "error");
            setError(`Error generating response: ${err.message}`);
            setStatusMessage("Response error");
        } finally {
            setIsGenerating(false);
            isGeneratingRef.current = false;
        }
    };

    /**
     * Converts a single text sentence into audio PCM and feeds it to Simli.
     */
    const speakSentence = async (sentence: string) => {
        try {
            logDebug(`Synthesizing speech PCM for sentence: "${sentence.slice(0, 25)}..."`, "info");
            const ttsUrl = `/api/tts?text=${encodeURIComponent(sentence)}`;
            const response = await fetch(ttsUrl);
            
            if (!response.ok) {
                throw new Error(`Proxy TTS HTTP Error ${response.status}`);
            }

            const arrayBuffer = await response.arrayBuffer();
            logDebug(`Synthesizer fetched array buffer successfully: ${arrayBuffer.byteLength} bytes`, "success");

            // Decode to a standard 16kHz mono audio context for Simli compatibility
            if (!audioContextRef.current) {
                logDebug("Initializing mono 16000Hz Audio Context pipeline...", "info");
                audioContextRef.current = new AudioContext({ sampleRate: 16000 });
            }

            logDebug("Decoding raw audio array data...", "info");
            const decodedBuffer = await audioContextRef.current.decodeAudioData(arrayBuffer);
            const channelData = decodedBuffer.getChannelData(0); // float32

            // Track exact playback duration to prevent microphone self-hearing echo loop
            const durationMs = decodedBuffer.duration * 1000;
            const now = Date.now();
            const startTimestamp = Math.max(now, playbackEndTimestampRef.current);
            playbackEndTimestampRef.current = startTimestamp + durationMs;
            logDebug(`Speech segment duration: ${durationMs.toFixed(0)}ms (Playback scheduled until ${new Date(playbackEndTimestampRef.current).toLocaleTimeString()})`, "info");

            // Convert Float32 values to standard signed Int16 PCM (16000Hz)
            const pcmData = new Int16Array(channelData.length);
            for (let i = 0; i < channelData.length; i++) {
                pcmData[i] = Math.max(-32768, Math.min(32767, Math.floor(channelData[i] * 32767)));
            }
            logDebug(`Audio successfully decoded to Int16 PCM (samples: ${pcmData.length})`, "success");

            // Add the chunk to the play queue
            audioChunkQueueRef.current.push(pcmData);
            if (!isProcessingChunkRef.current) {
                processNextAudioChunk();
            }

        } catch (err: any) {
            logDebug(`Speech synthesis pipeline failed: ${err.message}`, "error");
        }
    };

    /**
     * Processes the next audio chunk in the queue and forwards it to Simli
     */
    const processNextAudioChunk = useCallback(() => {
        if (
            audioChunkQueueRef.current.length > 0 &&
            !isProcessingChunkRef.current
        ) {
            isProcessingChunkRef.current = true;
            const audioChunk = audioChunkQueueRef.current.shift();
            if (audioChunk) {
                const chunkDurationMs = (audioChunk.length / 16000) * 1000;

                // Send downsampled 16kHz audio chunk to Simli Client WebRTC
                simliClient?.sendAudioData(audioChunk as any);
                logDebug(`Sent Int16 PCM chunk to WebRTC stream: ${chunkDurationMs.toFixed(1)}ms`, "info");
                
                isProcessingChunkRef.current = false;
                processNextAudioChunk();
            }
        }
    }, []);

    /**
     * Sequentially processes sentences queued in ttsSentenceQueueRef in the background
     */
    const processNextTtsSentence = useCallback(async () => {
        if (ttsSentenceQueueRef.current.length > 0 && !isSynthesizingRef.current) {
            isSynthesizingRef.current = true;
            const sentence = ttsSentenceQueueRef.current.shift();
            if (sentence) {
                try {
                    await speakSentence(sentence);
                } catch (e: any) {
                    logDebug(`Error processing queued TTS sentence: ${e.message}`, "error");
                }
            }
            isSynthesizingRef.current = false;
            // Tail-call to process the next sentence in the queue
            processNextTtsSentence();
        }
    }, [logDebug]);

    /**
     * Starts voice transcription via Web Speech Recognition API
     */
    const startRecording = useCallback(async () => {
        try {
            logDebug("Starting voice capture & speech recognition...", "info");
            const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
            if (!SpeechRecognition) {
                throw new Error("Web Speech API is not supported in this browser. Please use Google Chrome or Microsoft Edge.");
            }

            const recognition = new SpeechRecognition();
            recognition.continuous = true;
            recognition.interimResults = true;
            recognition.lang = 'en-US';

            recognition.onstart = () => {
                logDebug("Microphone captures active. Speech recognizer started.", "success");
                setIsRecording(true);
                isRecordingRef.current = true;
                isMutedRef.current = false;
                setStatusMessage("Microphone active. Listening...");
            };

            recognition.onerror = (event: any) => {
                logDebug(`Speech recognition warning/error: ${event.error}`, "error");
                if (event.error === "no-speech") return;
                
                if (event.error === "not-allowed") {
                    setError("Microphone permission blocked. Please click the Lock/Microphone icon in your browser's address bar (next to 'localhost:3001') and choose 'Allow' to enable continuous speech interaction. You can still type in the text chat box below to talk to Tina!");
                    // Gracefully fail over: configure manual muted states so keyboard-chat remains fully functional
                    isMutedRef.current = true;
                    setIsRecording(false);
                    isRecordingRef.current = false;
                    setStatusMessage("Microphone offline (Permission Blocked). Keyboard active.");
                } else {
                    setError(`Speech recognition error: ${event.error}`);
                }
            };

            recognition.onend = () => {
                logDebug("Speech recognizer disconnected.", "info");
                
                // Continuous Speech Recognition Auto-Restart Loop:
                // Auto-restarts the speech recognizer after silence timeouts, only if the user hasn't manually muted.
                if (isAvatarVisible && !isMutedRef.current) {
                    logDebug("Continuous Loop: Auto-restarting speech recognizer...", "info");
                    setTimeout(() => {
                        if (isAvatarVisible && !isMutedRef.current) {
                            startRecording();
                        }
                    }, 250);
                } else {
                    setIsRecording(false);
                    isRecordingRef.current = false;
                }
            };

            recognition.onresult = async (event: any) => {
                const now = Date.now();
                const isSpeaking = now < playbackEndTimestampRef.current + 800; // 800ms cool-down
                
                if (isGeneratingRef.current || isSpeaking || !isAvatarVisibleRef.current) {
                    // Ignore mic input while the AI brain is thinking, the avatar is speaking, or the video feed is connecting
                    return;
                }

                let interimTranscript = "";
                let finalTranscript = "";

                for (let i = event.resultIndex; i < event.results.length; ++i) {
                    const transcriptPiece = event.results[i][0].transcript;
                    if (event.results[i].isFinal) {
                        finalTranscript += transcriptPiece;
                    } else {
                        interimTranscript += transcriptPiece;
                    }
                }

                if (interimTranscript) {
                    setLiveInterpreted(interimTranscript);
                }

                if (finalTranscript.trim()) {
                    const cleanedTranscript = finalTranscript.trim();
                    logDebug(`Final spoken text interpreted: "${cleanedTranscript}"`, "success");
                    setUserMessage(cleanedTranscript);
                    setLiveInterpreted(""); // Clear interim

                    // Add user message to history
                    const userMsgId = Date.now().toString();
                    setChatHistory(prev => [...prev, {
                        id: userMsgId,
                        sender: "user",
                        text: cleanedTranscript,
                        timestamp: new Date()
                    }]);

                    setStatusMessage("Gemini is thinking...");
                    await handleUserMessage(cleanedTranscript);
                }
            };

            recognitionRef.current = recognition;
            recognition.start();
        } catch (err: any) {
            logDebug(`Speech recognition start failed: ${err.message}`, "error");
            setError(err.message || "Error accessing microphone. Please grant mic permission.");
        }
    }, [initialPrompt, openai_model]);

    /**
     * Stops Speech recognition
     */
    const stopRecording = useCallback(() => {
        isMutedRef.current = true; // Mark as muted to prevent continuous loop from auto-restarting
        if (recognitionRef.current) {
            logDebug("Stopping voice transcription capture...", "info");
            recognitionRef.current.stop();
            recognitionRef.current = null;
        }
        setIsRecording(false);
        isRecordingRef.current = false;
    }, []);

    /**
     * Toggles continuous speech recognition
     */
    const toggleMic = () => {
        if (isRecording) {
            logDebug("Microphone manually muted by user.", "info");
            stopRecording();
            setStatusMessage("Microphone muted. Type your messages below.");
        } else {
            logDebug("Microphone manually activated by user.", "info");
            isMutedRef.current = false;
            startRecording();
        }
    };

    /**
     * Sends the text input value to Gemini
     */
    const handleSendMessage = async (e?: React.FormEvent) => {
        if (e) e.preventDefault();
        if (!textInput.trim() || isLoading || isGenerating) return;

        const messageText = textInput.trim();
        setTextInput(""); // Clear the input field
        setUserMessage(messageText);
        logDebug(`Text message sent by user: "${messageText}"`, "info");

        // Add user message to history
        const userMsgId = Date.now().toString();
        setChatHistory(prev => [...prev, {
            id: userMsgId,
            sender: "user",
            text: messageText,
            timestamp: new Date()
        }]);

        setStatusMessage("Gemini is thinking...");
        await handleUserMessage(messageText);
    };

    /**
     * Starts Simli visual session and initializes Gemini
     */
    const handleStart = useCallback(async () => {
        logDebug("Connection request triggered by user...", "info");
        
        // Synchronously initialize the speech recognition directly in the user click gesture!
        // This ensures the browser grants microphone access cleanly and avoids the 'not-allowed' error.
        startRecording();

        setIsLoading(true);
        setError("");
        onStart();

        try {
            await initializeSimliClient();
        } catch (error: any) {
            logDebug(`Visual stream startup crashed: ${error.message}`, "error");
            setError(`Error starting interaction: ${error.message}`);
        } finally {
            setIsLoading(false);
        }
    }, [onStart, initializeSimliClient]);

    /**
     * Handles stopping interaction and releasing mic/audio context
     */
    const handleStop = useCallback(async () => {
        logDebug("Disconnect request triggered by user...", "info");
        setIsLoading(false);
        setError("");
        stopRecording();
        setIsAvatarVisible(false);
        isAvatarVisibleRef.current = false;
        if (simliClient) {
            await simliClient.stop();
            simliClient = null;
        }
        if (audioContextRef.current) {
            audioContextRef.current.close();
            audioContextRef.current = null;
        }
        onClose();
        logDebug("Visual interaction stopped. WebRTC connection released.", "success");
    }, [stopRecording, onClose]);

    return (
        <div className="w-full max-w-6xl mx-auto px-4 py-4">
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
                {/* Left Column: Avatar Hologram Screen */}
                <div className="lg:col-span-5 flex flex-col justify-between bg-zinc-950/40 backdrop-blur-md border border-zinc-800/80 rounded-2xl p-6 shadow-2xl transition-all duration-300 hover:border-zinc-700/80 relative overflow-hidden">
                    {/* Glowing ambient background light behind avatar */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-72 bg-indigo-500/10 rounded-full blur-[100px] pointer-events-none" />

                    {/* Top status bar of the screen */}
                    <div className="flex items-center justify-between mb-4 z-10">
                        <div className="flex items-center gap-2">
                            <div className={cn(
                                "w-2 h-2 rounded-full",
                                isAvatarVisible ? "bg-emerald-500 animate-pulse" : "bg-zinc-650"
                            )} />
                            <span className="text-[11px] font-mono tracking-wider text-zinc-400 uppercase">
                                {isAvatarVisible ? "Active Hologram Feed" : "Feed Offline"}
                            </span>
                        </div>
                        <div className="text-[10px] font-mono text-zinc-500">
                            {isAvatarVisible ? "Latency: 24ms | P2P" : "Disconnected"}
                        </div>
                    </div>

                    {/* Avatar Video & Placeholder area */}
                    <div className="relative aspect-square w-full max-w-[360px] mx-auto rounded-xl overflow-hidden bg-zinc-900 border border-zinc-800/60 shadow-inner flex items-center justify-center group z-10">
                        {/* Always mount VideoBox so React refs bind successfully, but hide it offscreen when not active */}
                        <div className={cn(
                            "w-full h-full animate-fadeIn relative",
                            !isAvatarVisible ? "absolute -left-[9999px] opacity-0 pointer-events-none" : "block"
                        )}>
                            <VideoBox video={videoRef} audio={audioRef} />
                            {/* Soft sci-fi scanning overlay lines */}
                            <div className="absolute inset-0 bg-scanlines pointer-events-none opacity-20" />
                        </div>

                        {/* Render DottedFace placeholder when not active */}
                        {!isAvatarVisible && (
                            <div className="flex flex-col items-center justify-center p-6 text-center animate-fadeIn">
                                <DottedFace />
                                <span className="mt-4 text-xs font-mono text-zinc-400 max-w-[240px]">
                                    Visual connection idle. Click "Connect Live Avatar" below to initialize.
                                </span>
                            </div>
                        )}
                    </div>

                    {/* Bottom control controls for feed */}
                    <div className="mt-6 z-10 flex flex-col gap-3">
                        {error && (
                            <div className="flex items-start gap-2 text-red-400 bg-red-950/20 border border-red-900/30 p-3 rounded-lg text-xs animate-fadeIn">
                                <AlertCircle className="w-4 h-4 mt-0.5 shrink-0 text-red-500" />
                                <div>
                                    <span className="font-semibold block mb-0.5">Connection Error</span>
                                    {error}
                                </div>
                            </div>
                        )}

                        <div className="flex items-center justify-between text-xs text-zinc-400 font-mono px-1">
                            <span>Pipeline Status:</span>
                            <span className={cn(
                                "font-medium",
                                isAvatarVisible ? "text-indigo-400" : "text-zinc-500"
                            )}>
                                {statusMessage}
                            </span>
                        </div>

                        {!isAvatarVisible ? (
                            <button
                                onClick={handleStart}
                                disabled={isLoading}
                                className="w-full h-[52px] bg-gradient-to-r from-indigo-600 to-violet-600 text-white font-semibold rounded-xl transition-all duration-300 hover:from-indigo-500 hover:to-violet-500 active:scale-[0.98] shadow-[0_0_20px_rgba(99,102,241,0.2)] hover:shadow-[0_0_25px_rgba(99,102,241,0.4)] disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:pointer-events-none flex justify-center items-center gap-2 group"
                            >
                                {isLoading ? (
                                    <>
                                        <Loader2 className="w-5 h-5 animate-spin" />
                                        <span>Connecting Stream...</span>
                                    </>
                                ) : (
                                    <>
                                        <Sparkles className="w-5 h-5 group-hover:animate-pulse text-indigo-200" />
                                        <span>Connect Live Avatar</span>
                                    </>
                                )}
                            </button>
                        ) : (
                            <div className="flex gap-2">
                                <button
                                    onClick={toggleMic}
                                    className={cn(
                                        "h-[52px] px-4 rounded-xl border transition-all duration-300 flex items-center justify-center gap-2 font-medium active:scale-[0.98] text-sm flex-1",
                                        isRecording 
                                            ? "bg-red-950/30 border-red-500/40 text-red-400 hover:bg-red-950/50 shadow-[0_0_15px_rgba(239,68,68,0.15)]"
                                            : "bg-zinc-900 border-zinc-800 text-zinc-300 hover:bg-zinc-800"
                                    )}
                                    title={isRecording ? "Mute Microphone" : "Unmute Microphone"}
                                >
                                    {isRecording ? <Mic className="w-5 h-5 text-red-500 animate-pulse" /> : <MicOff className="w-5 h-5 text-zinc-500" />}
                                    <span>{isRecording ? "Mute Mic" : "Unmute Mic"}</span>
                                </button>
                                <button
                                    onClick={handleStop}
                                    className="flex-1 h-[52px] bg-zinc-900 border border-zinc-800 hover:bg-red hover:border-red/40 hover:text-white text-zinc-300 font-semibold rounded-xl transition-all duration-300 active:scale-[0.98] flex justify-center items-center gap-2"
                                >
                                    <StopCircle className="w-5 h-5" />
                                    <span>Disconnect</span>
                                </button>
                            </div>
                        )}
                    </div>

                    {/* DYNAMIC SYSTEM DIAGNOSTICS TERMINAL */}
                    <div className="mt-5 z-10 flex flex-col bg-zinc-950 border border-zinc-900 rounded-xl p-3 shadow-inner">
                        <div className="flex items-center justify-between border-b border-zinc-900 pb-1.5 mb-1.5">
                            <span className="text-[10px] font-mono font-bold tracking-widest text-zinc-500 uppercase flex items-center gap-1.5">
                                <span className="w-1.5 h-1.5 bg-indigo-500 rounded-full animate-pulse" />
                                System Diagnostics Log
                            </span>
                            <button 
                                onClick={() => setDebugLogs([])}
                                className="text-[9px] font-mono text-zinc-600 hover:text-zinc-400 transition-colors uppercase"
                                title="Clear diagnostics terminal logs"
                            >
                                Clear
                            </button>
                        </div>
                        <div className="font-mono text-[9px] leading-relaxed h-[100px] overflow-y-auto space-y-1 scrollbar-thin select-text">
                            {debugLogs.length === 0 ? (
                                <span className="text-zinc-600 italic block">Diagnostics idle. Click "Connect Live Avatar" to stream diagnostic logs...</span>
                            ) : (
                                debugLogs.map((log, index) => {
                                    let textColor = "text-zinc-400";
                                    if (log.includes("[ERROR]")) textColor = "text-red-400 font-semibold animate-pulse";
                                    if (log.includes("[SUCCESS]")) textColor = "text-emerald-400";
                                    return (
                                        <div key={index} className={cn("whitespace-pre-wrap break-all", textColor)}>
                                            {log}
                                        </div>
                                    );
                                })
                            )}
                            <div ref={debugEndRef} />
                        </div>
                    </div>
                </div>

                {/* Right Column: Chatbot Console */}
                <div className="lg:col-span-7 flex flex-col bg-zinc-950/40 backdrop-blur-md border border-zinc-800/80 rounded-2xl overflow-hidden shadow-2xl transition-all duration-300 hover:border-zinc-700/80">
                    {/* Chat Header */}
                    <div className="border-b border-zinc-800/80 p-4 bg-zinc-900/40 flex items-center justify-between">
                        <div className="flex items-center gap-3">
                            <div className="relative">
                                <div className="w-10 h-10 rounded-full bg-indigo-950/80 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold">
                                    {avatarName.slice(0, 1).toUpperCase()}
                                </div>
                                <div className={cn(
                                    "absolute bottom-0 right-0 w-3 h-3 rounded-full border-2 border-zinc-950",
                                    isAvatarVisible ? "bg-emerald-500 animate-pulse" : "bg-zinc-650"
                                )} />
                            </div>
                            <div>
                                <h3 className="font-semibold text-zinc-100 text-sm leading-tight">
                                    {avatarName}
                                </h3>
                                <p className="text-xs text-zinc-400 font-mono">
                                    Gemini 3 Flash Agent
                                </p>
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 px-3 py-1 bg-zinc-900 border border-zinc-800 rounded-full text-[11px] font-mono text-zinc-400">
                            <Terminal className="w-3 h-3 text-indigo-400" />
                            <span>Voice + Text Active</span>
                        </div>
                    </div>

                    {/* Chat Messages Log */}
                    <div className="flex-1 overflow-y-auto p-6 space-y-4 min-h-[380px] max-h-[480px] scrollbar-thin">
                        {chatHistory.length === 0 ? (
                            <div className="h-full flex flex-col items-center justify-center text-center p-8 mt-12">
                                <MessageSquare className="w-10 h-10 text-zinc-650 mb-3 stroke-[1.5]" />
                                <h4 className="text-zinc-300 font-medium text-sm mb-1">Interactive Console Ready</h4>
                                <p className="text-xs text-zinc-550 max-w-sm">
                                    {isAvatarVisible 
                                        ? "Start speaking or type a message to begin the conversation with Frank."
                                        : "Connect the live avatar in the left panel to initialize conversation streams."}
                                </p>
                            </div>
                        ) : (
                            chatHistory.map((msg) => (
                                <div
                                    key={msg.id}
                                    className={cn(
                                        "flex gap-3 max-w-[85%] animate-fadeIn",
                                        msg.sender === "user" ? "ml-auto flex-row-reverse" : "mr-auto"
                                    )}
                                >
                                    {/* Icon / Avatar for message sender */}
                                    <div className={cn(
                                        "w-8 h-8 rounded-full flex items-center justify-center shrink-0 border text-xs font-bold",
                                        msg.sender === "user" 
                                            ? "bg-zinc-900 border-zinc-800 text-indigo-400" 
                                            : "bg-indigo-950/80 border-indigo-500/20 text-indigo-300"
                                    )}>
                                        {msg.sender === "user" ? <User className="w-4 h-4" /> : <Bot className="w-4 h-4 text-indigo-400" />}
                                    </div>

                                    {/* Message Bubble */}
                                    <div className="flex flex-col">
                                        <div className={cn(
                                            "rounded-2xl px-4 py-3 text-sm leading-relaxed",
                                            msg.sender === "user"
                                                ? "bg-gradient-to-br from-indigo-600 to-violet-600 text-white rounded-tr-none shadow-[0_4px_12px_rgba(99,102,241,0.15)]"
                                                : "bg-zinc-900/90 border border-zinc-800/80 text-zinc-100 rounded-tl-none"
                                        )}>
                                            <p className="whitespace-pre-wrap">{msg.text}</p>
                                            
                                            {/* Typing glow effect for AI streaming */}
                                            {msg.isStreaming && (
                                                <span className="inline-flex gap-1 items-center ml-1 mt-1">
                                                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '0ms' }} />
                                                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '150ms' }} />
                                                    <span className="w-1.5 h-1.5 bg-indigo-400 rounded-full animate-bounce" style={{ animationDelay: '300ms' }} />
                                                </span>
                                            )}
                                        </div>
                                        <span className="text-[10px] text-zinc-500 font-mono mt-1 px-1">
                                            {msg.timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                                        </span>
                                    </div>
                                </div>
                            ))
                        )}

                        {/* Speech recognition interim "What I interpreted" banner inside chat log */}
                        {liveInterpreted && (
                            <div className="flex gap-3 max-w-[85%] ml-auto flex-row-reverse animate-pulse">
                                <div className="w-8 h-8 rounded-full flex items-center justify-center shrink-0 border bg-indigo-950/20 border-indigo-500/20 text-indigo-400 font-bold">
                                    <Mic className="w-4 h-4 text-indigo-400 animate-bounce" />
                                </div>
                                <div className="flex flex-col items-end">
                                    <div className="rounded-2xl rounded-tr-none px-4 py-3 text-sm leading-relaxed bg-zinc-900/40 border border-indigo-500/20 text-zinc-400 italic">
                                        <span className="text-[10px] uppercase font-mono tracking-widest text-indigo-400 block not-italic mb-1 font-semibold">
                                            Interpreting Speech...
                                        </span>
                                        "{liveInterpreted}"
                                    </div>
                                </div>
                            </div>
                        )}

                        <div ref={messagesEndRef} />
                    </div>

                    {/* Chat Input Console Area */}
                    <div className="border-t border-zinc-800/80 p-4 bg-zinc-900/20">
                        <form onSubmit={handleSendMessage} className="flex gap-2">
                            <input
                                type="text"
                                value={textInput}
                                onChange={(e) => setTextInput(e.target.value)}
                                disabled={!isAvatarVisible || isGenerating}
                                placeholder={
                                    !isAvatarVisible 
                                        ? "Connect avatar to begin chat..." 
                                        : isGenerating 
                                            ? "Gemini is responding..." 
                                            : "Type your message and press Enter..."
                                }
                                className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded-xl px-4 py-3 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-indigo-500/80 focus:ring-1 focus:ring-indigo-500/80 transition-all duration-300 disabled:opacity-50 disabled:cursor-not-allowed"
                            />
                            <button
                                type="submit"
                                disabled={!isAvatarVisible || !textInput.trim() || isGenerating}
                                className="w-[52px] h-[46px] sm:h-auto sm:w-auto sm:px-5 bg-gradient-to-r from-indigo-600 to-violet-600 hover:from-indigo-500 hover:to-violet-500 text-white rounded-xl font-semibold transition-all duration-300 flex items-center justify-center gap-2 active:scale-95 disabled:from-zinc-800 disabled:to-zinc-800 disabled:text-zinc-500 disabled:border-zinc-800 disabled:opacity-50 disabled:pointer-events-none"
                            >
                                <Send className="w-5 h-5 shrink-0" />
                                <span className="hidden sm:inline">Send</span>
                            </button>
                        </form>
                        <div className="flex items-center justify-between mt-2.5 px-1">
                            <span className="text-[10px] text-zinc-500 font-mono">
                                Powered by <span className="text-zinc-400 font-medium">Gemini 3 Flash</span> & <span className="text-zinc-400 font-medium">Audio Pipeline</span>
                            </span>
                            {isRecording && (
                                <span className="flex items-center gap-1.5 text-[10px] text-red-400 font-mono">
                                    <span className="w-1.5 h-1.5 bg-red-500 rounded-full animate-ping" />
                                    <span>Mic Active</span>
                                </span>
                            )}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default SimliOpenAI;
