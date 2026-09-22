# Tab or Right Arrow accepts a visible suggestion without executing it.
bleopt complete_auto_complete=1
bleopt history_share=1
ble-face -s auto_complete 'fg=#799c92'

# Change only the active suggestion keymap; ordinary Tab completion stays intact.
ble-bind -m auto_complete -f TAB auto_complete/insert
ble-bind -m auto_complete -f C-i auto_complete/insert
