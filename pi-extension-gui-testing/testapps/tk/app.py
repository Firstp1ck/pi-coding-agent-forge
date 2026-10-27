#!/usr/bin/env python3
"""Tkinter sample app: label "Waiting", button "Press me" → label "Pressed".

Tk 8.6 has no accessibility layer, so snapshots report coverage "none" and the
app is driven by screenshots and coordinates (spec §4.6).
"""
import tkinter as tk


def main():
    root = tk.Tk()
    root.title("Pi GUI Tk")
    root.geometry("320x160+40+40")
    label = tk.Label(root, text="Waiting", font=("DejaVu Sans", 16))
    label.pack(expand=True)
    button = tk.Button(root, text="Press me", font=("DejaVu Sans", 14),
                       command=lambda: label.configure(text="Pressed"))
    button.pack(pady=16)
    root.mainloop()


if __name__ == "__main__":
    main()
