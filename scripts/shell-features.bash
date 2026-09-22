# Source only in an interactive Bash terminal. Does not modify global startup files.
[[ $- == *i* ]] || return 0
if ((BASH_VERSINFO[0] < 4)); then
    printf '%s\n' 'History suggestions require Homebrew Bash; see the shared-browser-terminal skill.' >&2
    return 1
fi
[[ ${BROWSER_TERMINAL_FEATURES_LOADED:-} ]] && return 0
if [[ ! -r "$HOME/.local/share/blesh/ble.sh" ]]; then
    printf '%s\n' 'History suggestions need ~/.local/share/blesh/ble.sh; see the shared-browser-terminal skill.' >&2
    return 1
fi
shopt -s histappend
HISTSIZE=50000
HISTFILESIZE=100000
# Preserve the current HISTFILE and any existing history privacy filters.
source "$HOME/.local/share/blesh/ble.sh" --rcfile "${BASH_SOURCE[0]%/*}/blerc.bash"
[[ ${BLE_VERSION:-} ]] && BROWSER_TERMINAL_FEATURES_LOADED=1
