package actions

import (
	"errors"
	"fmt"
	"slices"
)

type quorumInput struct {
	Current struct {
		Core   []string `json:"core"`
		Access []string `json:"access"`
	} `json:"current"`
	Change struct {
		Core   []string `json:"core"`
		Access []string `json:"access"`
	} `json:"change"`
	Approvals []string `json:"approvals"`
}

var errWithAccess = errors.New("needs approval from another device that reaches this server")

func quorum(devices int) int {
	if devices > 2 {
		return 2
	}
	return 1
}

func sameSet(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for _, item := range a {
		if !slices.Contains(b, item) {
			return false
		}
	}
	return true
}

func evaluateQuorum(in quorumInput) error {
	var approvers []string
	for _, id := range in.Approvals {
		if !slices.Contains(approvers, id) {
			approvers = append(approvers, id)
		}
	}
	if len(approvers) == 0 {
		return errors.New("needs an approval")
	}
	for _, id := range approvers {
		if !slices.Contains(in.Current.Core, id) {
			return errors.New("an approval comes from a device the servers do not trust")
		}
	}
	core := in.Change.Core
	if core == nil {
		core = in.Current.Core
	}
	for _, id := range in.Change.Access {
		if !slices.Contains(core, id) {
			return errors.New("access names a device the servers do not trust")
		}
	}
	coreChanged := in.Change.Core != nil && !sameSet(in.Change.Core, in.Current.Core)
	if need := quorum(len(in.Current.Core)); coreChanged && len(approvers) < need {
		missing := need - len(approvers)
		plural := "s"
		if missing == 1 {
			plural = ""
		}
		return fmt.Errorf("needs %d more approval%s", missing, plural)
	}
	for _, id := range in.Change.Access {
		if slices.Contains(in.Current.Access, id) {
			continue
		}
		others := slices.DeleteFunc(slices.Clone(approvers), func(approver string) bool { return approver == id })
		if slices.ContainsFunc(others, func(approver string) bool { return slices.Contains(in.Current.Access, approver) }) {
			continue
		}
		if slices.ContainsFunc(in.Current.Access, func(member string) bool { return member != id }) {
			return errWithAccess
		}
		rest := slices.DeleteFunc(slices.Clone(in.Current.Core), func(member string) bool { return member == id })
		need := max(1, min(quorum(len(in.Current.Core)), len(rest)))
		if len(others) < need {
			if need == 1 {
				return errors.New("needs approval from another trusted device")
			}
			return errors.New("needs approval from two other trusted devices")
		}
	}
	for _, id := range in.Current.Access {
		if slices.Contains(in.Change.Access, id) {
			continue
		}
		if coreChanged && !slices.Contains(core, id) {
			continue
		}
		if !slices.ContainsFunc(approvers, func(approver string) bool {
			return approver == id || slices.Contains(in.Current.Access, approver)
		}) {
			return errWithAccess
		}
	}
	return nil
}
