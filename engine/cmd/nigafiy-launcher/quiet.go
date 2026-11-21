package main

import "os"

func quiet() bool { return os.Getenv("NIGAFIY_LAUNCHER_QUIET") == "1" }
