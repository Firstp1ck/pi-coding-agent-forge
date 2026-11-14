"""S1 sample app (Tk): a label over a large "Press me" button.

Clicking the button sets the label to "Pressed" and, when S1_MARKER is set,
writes that file, so the harness can tell a delivered click without UI
Automation. The button fills the lower part of the window, so a click at
70 % of the window height lands on it at any DPI or title-bar height.
"""
import os
import tkinter as tk

root = tk.Tk()
root.title("S1 Tk")
root.geometry("480x320+80+80")
label = tk.Label(root, text="Not pressed", font=("Segoe UI", 14))
label.pack(fill="x", ipady=20)


def pressed():
    label.config(text="Pressed")
    marker = os.environ.get("S1_MARKER")
    if marker:
        with open(marker, "w", encoding="utf-8") as handle:
            handle.write("pressed\n")


tk.Button(root, text="Press me", command=pressed, font=("Segoe UI", 14)).pack(fill="both", expand=True)
root.mainloop()
