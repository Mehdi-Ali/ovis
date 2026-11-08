### Added
- Settings → Experimental → Agent browser: More and the command palette open the browser an agent in
  the selected pane drives, live, beside the pane or as a sheet on a phone. It is view-only until you
  press Take control; Stop hands it back, and closing the panel or the connection ends control too.
  Ovis finds a Chromium browser started in the pane with a DevTools port
  (`--remote-debugging-port=0`), never your own browser, and says so when the agent drives its
  browser over a pipe. A browser a background daemon starts (agent-browser's) is not found yet. Blocked hosts are never shown or typed into on that device.
