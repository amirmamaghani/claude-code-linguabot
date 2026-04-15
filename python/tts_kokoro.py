#!/usr/bin/env python3
import argparse
import numpy as np
import soundfile as sf
from kokoro import KPipeline

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--lang", required=True)
    p.add_argument("--voice", required=True)
    p.add_argument("--output", required=True)
    p.add_argument("--speed", type=float, default=1.0)
    args = p.parse_args()

    pipeline = KPipeline(lang_code=args.lang)
    segments = list(pipeline(args.text, voice=args.voice, speed=args.speed))

    if segments:
        audio = np.concatenate([seg[2] for seg in segments])
        sf.write(args.output, audio, 24000)

if __name__ == "__main__":
    main()
