# Export report

Here's the thing: the export command really writes a CSV file. It is important to note that the file is created in the current directory. Additionally, the command simply keeps the source records unchanged. Additionally, the file contains the record ID, name, and creation date. The stakes are high. Let that sink in.

This isn't just a preview, but a saved copy of the selected records. The export is limited to records that your account can read. The filename is passed with the output option. The command never replaces an existing file unless you include the overwrite option. The default delimiter is a comma. The file uses UTF-8, and dates use UTC. At the end of the day, the command supports up to 10,000 records per export. It actually reports an error if you exceed that limit.

Run `records export --output records.csv` to save the file. Check the selected account before you run the command.
