#!/usr/bin/env python3
"""PySide6 sample app: label "Waiting", button "Press me" → label "Pressed"."""
import sys

from PySide6.QtWidgets import QApplication, QLabel, QPushButton, QVBoxLayout, QWidget


def main():
    app = QApplication(sys.argv)
    window = QWidget()
    window.setWindowTitle("Pi GUI PySide6")
    window.resize(320, 160)
    layout = QVBoxLayout(window)
    label = QLabel("Waiting")
    button = QPushButton("Press me")
    button.clicked.connect(lambda: label.setText("Pressed"))
    layout.addWidget(label)
    layout.addWidget(button)
    window.show()
    return app.exec()


if __name__ == "__main__":
    sys.exit(main())
