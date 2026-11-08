### Added
- Settings → Experimental → Agent browser: More and the command palette open the browser an agent in
  the selected pane drives, live, beside the pane or as a sheet on a phone. It is view-only until you
  press Take control; Stop hands it back, and closing the panel or the connection ends control too.
  Ovis finds a Chromium browser the agent started in the pane with a DevTools port (agent-browser,
  or a browser launched with `--remote-debugging-port=0`), never your own browser, and says so when
  the agent drives its browser over a pipe. Blocked hosts are never shown or typed into on that device.
