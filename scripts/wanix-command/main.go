// A command of the in-browser shell (src/wanix-plugin.js) that the page runs.
//
// rc in Wanix starts Go programs only, so cargo, clang and the other tools that
// run in the page are each this program, at /bin/<name>. It asks the page to
// run <name> with its arguments in its folder, through the page's own objects
// that Wanix shows as files (#js/gleTools), and copies the output back until
// the command ends; then it exits with the command's code. What each name runs
// as is in /etc/tools.
//
// The page's functions take blank-separated words, so what goes to them is
// base64: start gets name, folder and arguments joined by NULs and answers the
// job's number; poll answers "running|<out>|<err>" or "<code>|<out>|<err>".
// What is typed meanwhile the terminal gives the page (gleTools.input) itself.
//
// Built by `npm run build:wanix` (GOOS=js GOARCH=wasm) to public/wanix-command.wasm.
package main

import (
	"encoding/base64"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

var b64 = base64.StdEncoding

// Calls the page's gleTools[fn] with the words, its answer as text
func call(fn string, words ...string) (string, error) {
	f, err := os.OpenFile("#js/gleTools/"+fn, os.O_RDWR, 0)
	if err != nil {
		return "", err
	}
	defer f.Close()
	if _, err := f.Write([]byte(strings.Join(words, " ") + "\n")); err != nil {
		return "", err
	}
	out, err := io.ReadAll(f)
	return strings.TrimSpace(string(out)), err
}

func fail(name, msg string, code int) {
	os.Stderr.WriteString(name + ": " + msg + "\n")
	os.Exit(code)
}

func main() {
	name := filepath.Base(os.Args[0])
	dir, _ := os.Getwd()
	req := strings.Join(append([]string{name, dir}, os.Args[1:]...), "\x00")
	answer, err := call("start", b64.EncodeToString([]byte(req)))
	if err != nil {
		fail(name, "the page did not answer: "+err.Error(), 127)
	}
	job, err := strconv.Atoi(answer)
	if err != nil {
		msg, _ := b64.DecodeString(answer)
		fail(name, string(msg), 127)
	}
	id := strconv.Itoa(job)

	for {
		answer, err := call("poll", id)
		if err != nil {
			fail(name, err.Error(), 1)
		}
		parts := strings.SplitN(answer, "|", 3)
		if len(parts) != 3 {
			fail(name, "the page answered "+answer, 1)
		}
		out, _ := b64.DecodeString(parts[1])
		errOut, _ := b64.DecodeString(parts[2])
		os.Stdout.Write(out)
		os.Stderr.Write(errOut)
		if parts[0] != "running" {
			code, _ := strconv.Atoi(parts[0])
			os.Exit(code)
		}
		if len(out) == 0 && len(errOut) == 0 {
			time.Sleep(50 * time.Millisecond)
		}
	}
}
