package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"time"
	"unicode/utf8"
)

// Limits match the extension (extension/lib/model.js).
const (
	MaxIDLen    = 128
	MaxTitleLen = 500
	MaxNoteLen  = 5000
	MaxURLLen   = 10000
	MaxLabels   = 30
	MaxLabelLen = 50
	maxGroupID  = MaxIDLen
	timeLayout  = time.RFC3339Nano
	fieldSeq    = "seq"
)

// Colors are the 9 Chrome tab group colours.
var Colors = map[string]bool{
	"grey": true, "blue": true, "red": true, "yellow": true, "green": true,
	"pink": true, "purple": true, "cyan": true, "orange": true,
}

// Record is one validated group or bookmark. Data holds the record JSON
// exactly as the client sent it (without "seq"), so that unknown future
// fields and the exact timestamp strings are kept.
type Record struct {
	ID        string
	Kind      string
	UpdatedAt string
	updated   time.Time
	Data      json.RawMessage
}

// fields is the typed view used for validation only.
type fields struct {
	ID        *string   `json:"id"`
	Kind      *string   `json:"kind"`
	CreatedAt *string   `json:"createdAt"`
	UpdatedAt *string   `json:"updatedAt"`
	DeletedAt *string   `json:"deletedAt"`
	Name      *string   `json:"name"`
	GroupID   *string   `json:"groupId"`
	Title     *string   `json:"title"`
	URL       *string   `json:"url"`
	Note      *string   `json:"note"`
	Labels    *[]string `json:"labels"`
	Color     *string   `json:"color"`
}

func textLen(s string) int { return utf8.RuneCountInString(s) }

func parseTime(name string, v *string, required bool) (time.Time, error) {
	if v == nil {
		if required {
			return time.Time{}, fmt.Errorf("%s is required", name)
		}
		return time.Time{}, nil
	}
	t, err := time.Parse(timeLayout, *v)
	if err != nil {
		return time.Time{}, fmt.Errorf("%s is not an ISO 8601 time", name)
	}
	return t, nil
}

// ParseRecord validates one record from a client. It returns the record id
// (when it can be read) with any error, so the caller can report it.
func ParseRecord(raw json.RawMessage) (Record, string, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(raw, &obj); err != nil {
		return Record{}, "", errors.New("record is not a JSON object")
	}
	var f fields
	if err := json.Unmarshal(raw, &f); err != nil {
		return Record{}, "", fmt.Errorf("record has a field of the wrong type: %v", err)
	}
	id := ""
	if f.ID != nil {
		id = *f.ID
	}
	if id == "" || textLen(id) > MaxIDLen {
		return Record{}, id, errors.New("id must be a string of 1 to 128 characters")
	}
	if f.Kind == nil || (*f.Kind != "group" && *f.Kind != "bookmark") {
		return Record{}, id, errors.New(`kind must be "group" or "bookmark"`)
	}
	if _, err := parseTime("createdAt", f.CreatedAt, true); err != nil {
		return Record{}, id, err
	}
	updated, err := parseTime("updatedAt", f.UpdatedAt, true)
	if err != nil {
		return Record{}, id, err
	}
	if _, err := parseTime("deletedAt", f.DeletedAt, false); err != nil {
		return Record{}, id, err
	}
	if f.Color == nil || !Colors[*f.Color] {
		return Record{}, id, errors.New("color is not valid")
	}
	if f.Note != nil && textLen(*f.Note) > MaxNoteLen {
		return Record{}, id, errors.New("note is too long")
	}
	if f.Labels != nil {
		if len(*f.Labels) > MaxLabels {
			return Record{}, id, errors.New("too many labels")
		}
		for _, l := range *f.Labels {
			if l == "" || textLen(l) > MaxLabelLen {
				return Record{}, id, errors.New("a label is empty or too long")
			}
		}
	}

	switch *f.Kind {
	case "group":
		if f.Name == nil || *f.Name == "" || textLen(*f.Name) > MaxTitleLen {
			return Record{}, id, errors.New("name must be a string of 1 to 500 characters")
		}
	case "bookmark":
		// The group does not have to exist: a client can send a bookmark
		// before its group, or after the group was deleted.
		if f.GroupID == nil || *f.GroupID == "" || textLen(*f.GroupID) > maxGroupID {
			return Record{}, id, errors.New("groupId must be a string of 1 to 128 characters")
		}
		if f.URL == nil || *f.URL == "" || textLen(*f.URL) > MaxURLLen {
			return Record{}, id, errors.New("url must be a string of 1 to 10000 characters")
		}
		if f.Title != nil && textLen(*f.Title) > MaxTitleLen {
			return Record{}, id, errors.New("title is too long")
		}
	}

	// Keep the client's JSON, but never a client-sent "seq".
	delete(obj, fieldSeq)
	data, err := json.Marshal(obj)
	if err != nil {
		return Record{}, id, err
	}
	return Record{ID: id, Kind: *f.Kind, UpdatedAt: *f.UpdatedAt, updated: updated, Data: data}, id, nil
}

// withSeq returns the stored JSON with the server "seq" field added.
func withSeq(data []byte, seq int64) (json.RawMessage, error) {
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, err
	}
	obj[fieldSeq] = json.RawMessage(fmt.Sprint(seq))
	return json.Marshal(obj)
}
