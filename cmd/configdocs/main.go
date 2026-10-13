package main

import (
	"github.com/fdkevin0/mob/internal/configuration"
	"log"
	"os"
)

func main() {
	if err := os.WriteFile("docs/environment-variables.md", []byte(configuration.Reference()), 0644); err != nil {
		log.Fatal(err)
	}
}
