"""S1 sample app (PySide6 / Qt widgets): a label over a large "Press me" button.

Same contract as tk_app.py: the click sets the label to "Pressed" and writes
the S1_MARKER file when that variable is set.
"""
import os
import sys

from PySide6.QtWidgets import QApplication, QLabel, QPushButton, QVBoxLayout, QWidget


def main():
    app = QApplication(sys.argv)
    window = QWidget()
    window.setWindowTitle("S1 PySide6")
    window.setGeometry(80, 80, 480, 320)
    layout = QVBoxLayout(window)
    label = QLabel("Not pressed")
    button = QPushButton("Press me")
    button.setMinimumHeight(200)

    def pressed():
        label.setText("Pressed")
        marker = os.environ.get("S1_MARKER")
        if marker:
            with open(marker, "w", encoding="utf-8") as handle:
                handle.write("pressed\n")

    button.clicked.connect(pressed)
    layout.addWidget(label, 1)
    layout.addWidget(button, 3)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
