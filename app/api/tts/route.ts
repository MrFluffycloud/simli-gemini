import { NextResponse } from "next/server";

export async function GET(request: Request) {
    const { searchParams } = new URL(request.url);
    const text = searchParams.get("text");

    if (!text) {
        return new NextResponse("Missing text parameter", { status: 400 });
    }

    try {
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=en&client=tw-ob&q=${encodeURIComponent(text)}`;
        const response = await fetch(ttsUrl, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.0.0 Safari/537.36"
            }
        });

        if (!response.ok) {
            return new NextResponse(`Google TTS returned HTTP ${response.status}`, { status: response.status });
        }

        const audioBuffer = await response.arrayBuffer();

        return new NextResponse(audioBuffer, {
            headers: {
                "Content-Type": "audio/mpeg",
                "Cache-Control": "public, max-age=3600"
            }
        });
    } catch (error: any) {
        console.error("TTS Proxy error:", error);
        return new NextResponse(`Internal Server Error: ${error.message}`, { status: 500 });
    }
}
