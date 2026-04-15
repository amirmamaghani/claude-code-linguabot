#!/usr/bin/env python3
import argparse
from gtts import gTTS

def main():
    p = argparse.ArgumentParser()
    p.add_argument("--text", required=True)
    p.add_argument("--lang", required=True)
    p.add_argument("--output", required=True)
    args = p.parse_args()

    gTTS(text=args.text, lang=args.lang, slow=False).save(args.output)

if __name__ == "__main__":
    main()
