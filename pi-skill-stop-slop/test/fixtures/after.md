# Export report

The export command writes a CSV file in the current directory without changing the source records. It saves the selected records rather than displaying a preview. Your account's read permissions limit which records you can export.

Each row contains the record ID, name, and creation date. Files use UTF-8, comma delimiters, and UTC dates. Use the output option to choose a filename. To replace an existing file, include the overwrite option. An export can contain up to 10,000 records; the command reports an error if you exceed that limit.

Run `records export --output records.csv` to save the file. Check the selected account before you run the command.
