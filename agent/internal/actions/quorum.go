package actions

import (
	"errors"
	"fmt"
	"slices"
)

type quorumApproval struct {
	ID       string `json:"id"`
	Verified bool   `json:"verified"`
	UV       bool   `json:"uv"`
}

type quorumInput struct {
	Current struct {
		Core   []string `json:"core"`
		Access []string `json:"access"`
	} `json:"current"`
	Change struct {
		Core              []string `json:"core"`
		PassphraseChanged bool     `json:"passphraseChanged"`
		RequireUV         bool     `json:"requireUv"`
		Access            []string `json:"access"`
	} `json:"change"`
	Approvals []quorumApproval `json:"approvals"`
}

var errWithAccess = errors.New("needs approval from another device with access here")

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
	for _, approval := range in.Approvals {
		if !slices.Contains(approvers, approval.ID) {
			approvers = append(approvers, approval.ID)
		}
	}
	if len(approvers) == 0 {
		return errors.New("needs an approval")
	}
	for _, id := range approvers {
		if !slices.Contains(in.Current.Core, id) {
			return errors.New("an approval comes from outside the core")
		}
	}
	for _, approval := range in.Approvals {
		if !approval.Verified {
			return errors.New("an approval is not verified")
		}
	}
	core := in.Change.Core
	if core == nil {
		core = in.Current.Core
	}
	for _, id := range in.Change.Access {
		if !slices.Contains(core, id) {
			return errors.New("access names a device outside the core")
		}
	}
	coreChanged := in.Change.Core != nil && !sameSet(in.Change.Core, in.Current.Core)
	if coreChanged || in.Change.PassphraseChanged || in.Change.RequireUV {
		need := min(2, len(in.Current.Core))
		if len(approvers) < need {
			missing := need - len(approvers)
			plural := "s"
			if missing == 1 {
				plural = ""
			}
			return fmt.Errorf("needs %d more core device%s", missing, plural)
		}
	}
	if in.Change.RequireUV {
		for _, id := range core {
			if !slices.ContainsFunc(in.Approvals, func(approval quorumApproval) bool { return approval.ID == id && approval.UV }) {
				return errors.New("every core device that stays must approve with a fingerprint")
			}
		}
	}
	for _, id := range in.Change.Access {
		if slices.Contains(in.Current.Access, id) {
			continue
		}
		others := slices.DeleteFunc(slices.Clone(approvers), func(approver string) bool { return approver == id })
		if slices.ContainsFunc(others, func(approver string) bool { return slices.Contains(in.Current.Access, approver) }) {
			continue
		}
		rest := slices.DeleteFunc(slices.Clone(in.Current.Core), func(member string) bool { return member == id })
		if len(others) < min(2, len(rest)) {
			return errWithAccess
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
