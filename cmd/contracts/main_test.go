package main

import (
	"os"
	"testing"
)

func TestContractIsCurrent(t *testing.T) {
	raw, err := os.ReadFile("../../webapp/src/chat/contracts.ts")
	if err != nil {
		t.Fatal(err)
	}
	if string(raw) != contract() {
		t.Fatal("run bun run generate:contracts")
	}
}
