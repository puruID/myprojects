@Author PURU ARORA
Date created : 01 10 2026



RAID Log (project delivery tracker)

A tracker for the four things every project steering meeting asks about:
Risks, Assumptions, Issues and Dependencies. Built with plain HTML, CSS and
JavaScript. No build step, no framework.

Features

Add, edit and delete entries. Each one gets a reference like R-001, A-002, I-003, D-001.
Risks are scored likelihood x impact (1-5 each, max 25) and rated High (15+), Medium (8-14) or Low.
Assumptions, issues and dependencies get a High / Medium / Low priority.
Dependencies record who you're waiting on.
Summary tiles show open, high-rated, overdue and closed counts for each type.
A 5x5 heat map shows where the open risks sit. Click a cell to filter the log to it.
Filter by type, status or overdue, search any text, and sort by any column.
Due dates turn amber inside 7 days and red once overdue.
Export the whole log to CSV for reports or Excel.

How it Works

Open index.html in a browser. The first time, it loads a few example entries
so you can see how it works. Click "Remove examples" when you're ready to use it for real.
Click any row to edit it. Click the project name at the top to rename it.
Entries are saved in your browser's localStorage, so they stay put between visits
on the same browser. Export to CSV if you want a copy elsewhere.

When published as a claude.ai artifact, the same page saves to the artifact's
shared database instead, so everyone with access sees the same log.
